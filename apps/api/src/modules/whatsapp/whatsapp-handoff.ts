// Talking to a person on WhatsApp. Two separate things live here:
//
//   1. A patient asks for a person (`wantsHuman`, or the menu's "talk to a human" button). The bot is NOT
//      silenced: it sends the patient a button that opens a WhatsApp chat with the clinic's human
//      support -- one receptionist, chosen in the Users tab (memberships/human-support.ts) -- and carries
//      on exactly as before. Works on every kind of number.
//
//   2. Staff reply from the WhatsApp Business app on a COEXISTENCE number (Meta's echo). Clinics are
//      asked not to, but if someone does, the bot goes quiet on THAT chat so a patient is not answered
//      by a person and the bot at once. The pause is per chat, ends by itself after 2 hours from the
//      last reply, and the desk can end it sooner:
//
//        - staff reply from the Business app (Meta's echo)   -> pause, extended on every reply
//        - staff press "return to bot" in the web app          -> pause cleared
//
import { Prisma } from "../../generated/prisma/client.ts";
import { withTenant, type ActorContext, type TransactionClient } from "../../prisma/with-tenant.ts";
import { recordNotification } from "../notifications/notifications.service.ts";
import { botActorContext, recordOutboundMessage } from "./whatsapp-conversation.ts";
import { noteSendFailure } from "./whatsapp-connections.ts";
import { T, type Lang } from "./whatsapp-flow-text.ts";
import type { FlowState } from "./whatsapp-flow.ts";
import { sendWhatsAppText, sendWhatsAppUrlButton } from "./whatsapp-graph-client.ts";
import type { MetaEchoMessage } from "./meta-webhook-payload.ts";
import { resolveTenantByPhoneNumberId, type ResolvedWhatsAppTenant } from "./whatsapp-tenants.ts";

/** How long a pause lasts, from the last staff reply. */
export const HANDOFF_PAUSE_MS = 2 * 60 * 1000;

/** A bot reply that goes out is logged a moment later; Meta's echo of a human message can race it. */
const ECHO_SETTLE_MS = 3000;

/** Past this many words a message is a story, not a request to be connected to someone. */
const MAX_WORDS = 40;

// -------------------------------------------------------------------------------------------
// Recognising "I want a person" -- Arabic and English
// -------------------------------------------------------------------------------------------

/** Lower-case, strip Arabic diacritics and tatweel, fold alef/yaa/taa-marbuta variants, drop punctuation. */
function normalise(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u064B-\u065F\u0670\u0640]/g, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Phrases that mean "a person" on their own, written in normalised form (see `normalise`). */
const STRONG_PHRASES = [
  // Arabic
  "خدمه العملاء", "خدمه عملاء", "خدمه الزبائن", "رقم خدمه العملاء",
  "شخص حقيقي", "حد حقيقي", "موظف حقيقي", "انسان", "شخص بشري", "حد بشري", "بشري",
  "كلم حد", "اكلم حد", "اتكلم مع حد", "كلمني حد", "حد يكلمني", "حد يرد عليا", "حد يرد علي",
  "عايز اكلم حد", "عاوز اكلم حد", "عايز اتكلم مع حد", "عاوز اتكلم مع حد",
  "عايز اكلم موظف", "عاوز اكلم موظف", "اكلم موظف", "اتكلم مع موظف", "اتكلم مع موظفه",
  // English
  "customer service", "customer support", "customer care", "human", "real person", "live person",
  "live agent", "human agent", "representative", "talk to someone", "speak to someone",
  "talk to somebody", "speak to somebody", "talk with someone", "speak with someone",
  "talk to a person", "speak to a person", "talk to a human", "speak to a human", "agent",
];

/** Words for a staff member. Not enough alone ("the employee was rude" is a complaint, not a request). */
const ROLE_WORDS = [
  "موظف", "موظفه", "موظفين", "سكرتير", "سكرتيره", "سكرتاريه", "ريسبشن", "استقبال", "مسئول", "مسؤول",
  "الموظف", "الموظفه", "الموظفين", "السكرتير", "السكرتيره", "السكرتاريه", "الريسبشن", "الاستقبال", "المسئول", "المسؤول",
  "staff", "receptionist", "employee", "secretary", "operator", "manager", "someone", "somebody", "person",
];

/** ...which only counts next to a word asking to be connected to them. */
const REQUEST_WORDS = [
  "كلم", "اكلم", "اتكلم", "كلمني", "اتواصل", "توصلني", "وصلني", "حولني", "عايز", "عاوز", "محتاج", "اريد", "ابغي", "ابي",
  "talk", "speak", "chat", "call", "connect", "transfer", "contact", "need", "want", "reach", "get me", "put me",
];

/** A message that is really a complaint ("the employee was rude") is not a request to reach staff. */
const COMPLAINT_STEMS = ["شكو", "اشتكي", "مشكله", "بلاغ", "complain", "complaint"];

function containsPhrase(padded: string, phrase: string): boolean {
  return padded.includes(` ${normalise(phrase)} `);
}

/** Free-text answers (the medical complaint, a name, a phone) must never be read as a command. */
const FREE_TEXT_STEPS = new Set<string>(["BOOKING_COMPLAINT", "NAME_ASK", "PHONE_ASK"]);

export function wantsHuman(text: string, state: FlowState | null): boolean {
  if (state !== null && FREE_TEXT_STEPS.has(state.step)) return false;

  const norm = normalise(text);
  if (norm === "" || norm.split(" ").length > MAX_WORDS) return false;
  const padded = ` ${norm} `;

  if (STRONG_PHRASES.some((phrase) => containsPhrase(padded, phrase))) return true;

  if (COMPLAINT_STEMS.some((stem) => norm.includes(stem))) return false;
  return (
    ROLE_WORDS.some((word) => containsPhrase(padded, word)) &&
    REQUEST_WORDS.some((word) => containsPhrase(padded, word))
  );
}

// -------------------------------------------------------------------------------------------
// Pausing
// -------------------------------------------------------------------------------------------

/** `PATIENT_REQUEST` is only ever read, from a pause written before human support replaced it. */
type PauseReason = "PATIENT_REQUEST" | "STAFF_REPLY";

/** Pauses (or extends the pause on) one conversation after a staff reply, inside the caller's transaction. */
async function pauseInTx(tx: TransactionClient, conversationId: string, now: Date): Promise<void> {
  const conversation = await tx.conversation.findFirst({
    where: { id: conversationId },
    select: { botPausedUntil: true },
  });
  if (conversation === null) return;

  const target = new Date(now.getTime() + HANDOFF_PAUSE_MS);
  const alreadyPaused = conversation.botPausedUntil !== null && conversation.botPausedUntil.getTime() > now.getTime();
  const until = alreadyPaused && (conversation.botPausedUntil as Date).getTime() > target.getTime()
    ? (conversation.botPausedUntil as Date)
    : target;

  await tx.conversation.update({
    where: { id: conversationId },
    data: {
      botPausedUntil: until,
      botPausedReason: "STAFF_REPLY",
      // Whatever the bot was half-way through is stale once a person has spoken; when the bot comes
      // back it starts from the menu rather than resuming a question from hours ago.
      flowState: Prisma.JsonNull,
      lastAiResponseId: null,
    },
  });
}

/** The wa.me address of a chat with `phoneE164`, with `text` already typed into it. */
export function whatsAppChatLink(phoneE164: string, text: string): string {
  return `https://wa.me/${phoneE164.replace(/\D/g, "")}?text=${encodeURIComponent(text)}`;
}

/**
 * The patient asked for a person. Send them a button that opens a chat with the clinic's human support,
 * and tell the desk. Nothing about the conversation changes: the bot is not paused and the saved flow
 * state is left alone, so the patient can come back and carry on. With no human support set up, the
 * patient is told so and offered a booking instead.
 */
export async function handleHumanRequest(args: {
  tenant: ResolvedWhatsAppTenant;
  waId: string;
  conversationId: string;
  contactId: string;
  lang: Lang;
}): Promise<void> {
  const { tenant, waId, conversationId, contactId, lang } = args;
  const supportPhone = tenant.humanSupportPhone ?? null;
  const clinicName = lang === "ar" ? tenant.clinicName : (tenant.clinicNameEn ?? tenant.clinicName);

  try {
    let externalMessageId: string;
    let loggedText: string;

    if (supportPhone === null) {
      loggedText = T.handoffUnavailable(lang);
      externalMessageId = (await sendWhatsAppText(tenant.phoneNumberId, waId, loggedText, tenant.accessToken)).externalMessageId;
    } else {
      const body = T.handoffLinkBody(lang);
      const label = T.handoffLinkButton(lang);
      const url = whatsAppChatLink(supportPhone, T.handoffPrefill(lang, clinicName));
      externalMessageId = (await sendWhatsAppUrlButton(tenant.phoneNumberId, waId, body, label, url, tenant.accessToken)).externalMessageId;
      loggedText = `${body}\n[${label}]`;
    }

    await recordOutboundMessage(tenant.id, tenant.bot, {
      conversationId,
      contactId,
      externalMessageId,
      text: loggedText,
      now: new Date(),
    });
  } catch (error) {
    console.error("WhatsApp: human support request failed", error);
    await noteSendFailure(tenant.id, error);
    return;
  }

  if (supportPhone === null) return;

  // The desk's heads-up that a patient is about to write to the human support. Its own step: the patient
  // already has their link, so a failure here is logged and nothing more.
  await withTenant(tenant.id, botActorContext(tenant.bot), async (tx) => {
    const conversation = await tx.conversation.findFirst({
      where: { id: conversationId },
      select: { contact: { select: { phoneE164: true } } },
    });
    await recordNotification(tx, tenant.bot.userId, {
      kind: "HANDOFF_REQUESTED",
      appointmentId: null,
      patientId: null,
      source: "WHATSAPP",
      occurredAt: new Date(),
      payload: { conversationId, phone: conversation?.contact.phoneE164 ?? "" },
    });
  }).catch((error: unknown) => console.error("WhatsApp: could not record the human support notification", error));
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Meta echoes every message a person sends from the WhatsApp Business app on a coexistence number.
 * A message we did not send ourselves means a person is in the chat: pause the bot there, and keep
 * extending the pause for as long as they keep replying. Nothing from the echo is stored.
 */
export async function handleStaffEchoes(phoneNumberId: string, echoes: MetaEchoMessage[]): Promise<void> {
  if (echoes.length === 0) return;

  const tenant = await resolveTenantByPhoneNumberId(phoneNumberId);
  if (tenant === null || tenant.numberMode !== "COEXISTENCE") return;

  // If Meta also echoes the bot's own sends, the echo can land before `recordOutboundMessage` has
  // written that message's id. Waiting once makes "is this one of ours?" a fair question.
  await sleep(ECHO_SETTLE_MS);

  const actor = botActorContext(tenant.bot);
  for (const echo of echoes) {
    if (!echo.id || !echo.to) continue;
    const phoneE164 = `+${echo.to}`;
    const now = new Date();

    await withTenant(tenant.id, actor, async (tx) => {
      const ours = await tx.message.findFirst({ where: { externalMessageId: echo.id }, select: { id: true } });
      if (ours !== null) return;

      const contact = await tx.contact.findFirst({ where: { phoneE164 }, select: { id: true } });
      if (contact === null) return;
      const conversation = await tx.conversation.findFirst({
        where: { contactId: contact.id, status: "OPEN" },
        select: { id: true },
      });
      // A person writing first to someone the bot has never talked to is not the bot's business.
      if (conversation === null) return;

      await pauseInTx(tx, conversation.id, now);
    }).catch((error: unknown) => console.error("WhatsApp: could not apply a staff echo", error));
  }
}

// -------------------------------------------------------------------------------------------
// The desk's side: see what is paused, hand a chat back
// -------------------------------------------------------------------------------------------

export interface PausedChat {
  conversationId: string;
  phone: string;
  pausedUntil: Date;
  reason: PauseReason;
}

export async function listPausedChats(tenantId: string, actor: ActorContext): Promise<PausedChat[]> {
  const now = new Date();
  return withTenant(tenantId, actor, async (tx) => {
    const rows = await tx.conversation.findMany({
      where: { botPausedUntil: { gt: now } },
      select: { id: true, botPausedUntil: true, botPausedReason: true, contact: { select: { phoneE164: true } } },
      orderBy: { botPausedUntil: "desc" },
      take: 50,
    });
    return rows.map((row) => ({
      conversationId: row.id,
      phone: row.contact.phoneE164,
      pausedUntil: row.botPausedUntil as Date,
      reason: (row.botPausedReason === "STAFF_REPLY" ? "STAFF_REPLY" : "PATIENT_REQUEST") as PauseReason,
    }));
  });
}

/** `false` when there is no such conversation in this clinic. Resuming one that is not paused is fine. */
export async function resumeBot(tenantId: string, actor: ActorContext, conversationId: string): Promise<boolean> {
  return withTenant(tenantId, actor, async (tx) => {
    const existing = await tx.conversation.findFirst({ where: { id: conversationId }, select: { id: true } });
    if (existing === null) return false;
    await tx.conversation.update({
      where: { id: conversationId },
      data: { botPausedUntil: null, botPausedReason: null },
    });
    return true;
  });
}

/** Hands every paused chat of this clinic back to the bot at once. Returns how many were paused. */
export async function resumeAllBots(tenantId: string, actor: ActorContext): Promise<number> {
  const now = new Date();
  return withTenant(tenantId, actor, async (tx) => {
    const result = await tx.conversation.updateMany({
      where: { botPausedUntil: { gt: now } },
      data: { botPausedUntil: null, botPausedReason: null },
    });
    return result.count;
  });
}
