// Human handoff on a WhatsApp conversation. While `Conversation.botPausedUntil` is in the future the
// bot stays silent on that chat, and a person answers on the clinic's number from the WhatsApp
// Business app. Two things start a pause, one thing ends it early, and time ends it otherwise:
//
//   - the patient asks for a person (`wantsHuman`)          -> pause + a desk notification
//   - staff reply from the Business app (Meta's echo)        -> pause, extended on every reply
//   - staff press "return to bot" in the web app             -> pause cleared
//
// Only a COEXISTENCE number has a person to hand over to. On a NEW_NUMBER number nobody can answer
// from a phone, so the patient is told plainly that it is not available and the bot carries on.

import { Prisma } from "../../generated/prisma/client.ts";
import { withTenant, type ActorContext, type TransactionClient } from "../../prisma/with-tenant.ts";
import { recordNotification } from "../notifications/notifications.service.ts";
import { botActorContext, recordOutboundMessage } from "./whatsapp-conversation.ts";
import { noteSendFailure } from "./whatsapp-connections.ts";
import { detectLang, T } from "./whatsapp-flow-text.ts";
import type { FlowState } from "./whatsapp-flow.ts";
import { sendWhatsAppText } from "./whatsapp-graph-client.ts";
import type { MetaEchoMessage } from "./meta-webhook-payload.ts";
import { resolveTenantByPhoneNumberId, type ResolvedWhatsAppTenant } from "./whatsapp-tenants.ts";

/** How long a pause lasts, from the last human signal. */
export const HANDOFF_PAUSE_MS = 4 * 60 * 60 * 1000;

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

/** A message that is really a complaint (the flow has its own path for those). */
const COMPLAINT_STEMS = ["شكو", "اشتكي", "مشكله", "بلاغ", "complain", "complaint"];

function containsPhrase(padded: string, phrase: string): boolean {
  return padded.includes(` ${normalise(phrase)} `);
}

/** Free-text answers (a complaint's body, a name, a phone) must never be read as a command. */
const FREE_TEXT_STEPS = new Set<string>(["COMPLAINT_TEXT", "NAME_ASK", "PHONE_ASK"]);

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

type PauseReason = "PATIENT_REQUEST" | "STAFF_REPLY";

/** Pauses (or extends the pause on) one conversation, inside the caller's transaction. */
async function pauseInTx(
  tx: TransactionClient,
  actorUserId: string,
  conversationId: string,
  reason: PauseReason,
  now: Date,
  notify: boolean,
): Promise<void> {
  const conversation = await tx.conversation.findFirst({
    where: { id: conversationId },
    select: { botPausedUntil: true, botPausedReason: true, contact: { select: { phoneE164: true } } },
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
      botPausedReason: alreadyPaused ? (conversation.botPausedReason ?? reason) : reason,
      // Whatever the bot was half-way through is stale once a person has spoken; when the bot comes
      // back it starts from the menu rather than resuming a question from hours ago.
      flowState: Prisma.JsonNull,
      lastAiResponseId: null,
    },
  });

  if (notify) {
    await recordNotification(tx, actorUserId, {
      kind: "HANDOFF_REQUESTED",
      appointmentId: null,
      patientId: null,
      source: "WHATSAPP",
      occurredAt: now,
      payload: { conversationId, phone: conversation.contact.phoneE164 },
    });
  }
}

/**
 * The patient asked for a person. Coexistence number: pause the bot, tell the desk, tell the patient
 * someone will reply. Any other number: tell the patient it is not available, and leave the chat as it was.
 */
export async function handleHumanRequest(args: {
  tenant: ResolvedWhatsAppTenant;
  waId: string;
  conversationId: string;
  contactId: string;
  text: string;
}): Promise<void> {
  const { tenant, waId, conversationId, contactId, text } = args;
  const lang = detectLang(text);
  const now = new Date();
  const coexistence = tenant.numberMode === "COEXISTENCE";

  try {
    if (coexistence) {
      await withTenant(tenant.id, botActorContext(tenant.bot), (tx) =>
        pauseInTx(tx, tenant.bot.userId, conversationId, "PATIENT_REQUEST", now, true),
      );
    }

    const reply = coexistence ? T.handoffRequested(lang) : T.handoffUnavailable(lang);
    const sent = await sendWhatsAppText(tenant.phoneNumberId, waId, reply, tenant.accessToken);
    await recordOutboundMessage(tenant.id, tenant.bot, {
      conversationId,
      contactId,
      externalMessageId: sent.externalMessageId,
      text: reply,
      now: new Date(),
    });
  } catch (error) {
    console.error("WhatsApp: human handoff failed", error);
    await noteSendFailure(tenant.id, error);
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Meta echoes every message a person sends from the WhatsApp Business app on a coexistence number.
 * A message we did not send ourselves means a human is in the chat: pause the bot there, and keep
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

      await pauseInTx(tx, tenant.bot.userId, conversation.id, "STAFF_REPLY", now, false);
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

