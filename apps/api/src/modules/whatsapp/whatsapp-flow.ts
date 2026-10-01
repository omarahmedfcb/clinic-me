// The WhatsApp bot's step machine -- code decides which fixed-template question comes next, buttons
// and lists carry the answer back, and the model is used only for two narrow jobs: guessing intent
// from a vague opening message, and answering an off-script question without derailing the step the
// patient is mid-way through. Booking and filing a complaint never touch the model at all -- every
// fact in a booking or a complaint comes from a tool result or the patient's own tap, exactly the
// property SYSTEM_PROMPT (whatsapp-orchestrator.ts) already asked of the old all-GPT flow, now held
// by construction instead of by instruction.
//
// State lives in `Conversation.flowState` (schema.prisma), written and read only here. A tapped
// button's `id` is meaningful only against the specific step that offered it -- this file is the
// only place that interprets one, and it dispatches purely on `state.step`, never on the id alone.

import { normalisePhone } from "../auth/phone.ts";
import { callGpt } from "../webchat/gpt-client.ts";
import { formatInClinicTime, parseFlexibleDate, todayInClinic } from "../../common/clinic-time.ts";
import type { BotApiClient } from "./bot-api-client.ts";
import { detectLang, T, type Lang } from "./whatsapp-flow-text.ts";
import type { WhatsAppButton, WhatsAppListSection } from "./whatsapp-graph-client.ts";
import type { WhatsAppTenant } from "./whatsapp-tenants.ts";
import type { InboundWhatsAppInput } from "./whatsapp-orchestrator.ts";

const EGYPT = "EG" as const;
/** How long a conversation can sit idle before the next message opens a new session -- a fresh
 *  welcome line, and any half-finished flow discarded (whatsapp-conversation.ts's own note on why
 *  that discard is safe: nothing about the Conversation row itself changes). */
export const WELCOME_IDLE_GAP_MS = 6 * 60 * 60 * 1000;

const SLOTS_PER_PAGE = 9;
/** How many upcoming calendar days to probe, at most, while building the date list -- bounded so a
 *  doctor with a mostly-empty calendar cannot turn one BOOKING_DATE step into weeks of sequential
 *  API calls. A doctor with no slot inside three weeks is treated the same as one with none at all
 *  (bookingNoDatesAhead), which is an honest answer either way. */
const DATE_SEARCH_HORIZON_DAYS = 21;
const DATES_WANTED = 7;

type Intent = "booking" | "complaint";

interface Person {
  patientId: string;
  patientName: string;
}

/** Every shape `Conversation.flowState` can hold. Every step past IDENTITY carries `lang` and,
 *  once resolved, the patient -- both are settled once per flow and never re-asked mid-way. */
export type FlowState =
  | { step: "INTENT"; lang: Lang }
  | { step: "IDENTITY_PICK"; lang: Lang; intent: Intent; phoneE164: string; options: { patientId: string; name: string }[] }
  | { step: "IDENTITY_YESNO"; lang: Lang; intent: Intent; phoneE164: string; patientId: string; patientName: string }
  | { step: "PHONE_CHOICE"; lang: Lang; intent: Intent }
  | { step: "PHONE_ASK"; lang: Lang; intent: Intent }
  | { step: "NAME_ASK"; lang: Lang; intent: Intent; phoneE164: string }
  | ({ step: "BOOKING_DOCTOR"; lang: Lang } & Person)
  | ({ step: "BOOKING_SERVICE"; lang: Lang; doctorId: string; doctorName: string } & Person)
  | ({ step: "BOOKING_DATE"; lang: Lang; doctorId: string; doctorName: string; serviceId: string; serviceName: string } & Person)
  | ({ step: "BOOKING_DATE_FREE"; lang: Lang; doctorId: string; doctorName: string; serviceId: string; serviceName: string } & Person)
  | ({
      step: "BOOKING_SLOT";
      lang: Lang;
      doctorId: string;
      doctorName: string;
      serviceId: string;
      serviceName: string;
      date: string;
      slots: { iso: string; token: string; label: string }[];
      page: number;
    } & Person)
  | ({
      step: "BOOKING_CONFIRM";
      lang: Lang;
      doctorId: string;
      doctorName: string;
      serviceId: string;
      serviceName: string;
      date: string;
      slotIso: string;
      slotLabel: string;
      token: string;
    } & Person)
  | ({ step: "COMPLAINT_TEXT"; lang: Lang } & Person)
  | ({ step: "COMPLAINT_CONFIRM"; lang: Lang; text: string } & Person);

export interface FlowContext {
  tenant: WhatsAppTenant;
  client: BotApiClient;
  /** The sender's own WhatsApp number, already in E.164 (whatsapp.controller.ts's own conversion) --
   *  the starting point for identity resolution, and never itself typed by the patient at any step. */
  phoneE164: string;
  input: InboundWhatsAppInput;
  state: FlowState | null;
  isNewSession: boolean;
  inboundExternalMessageId: string;
}

export type FlowOutgoing =
  | { kind: "text"; text: string }
  | { kind: "buttons"; body: string; buttons: WhatsAppButton[] }
  | { kind: "list"; body: string; buttonLabel: string; sections: WhatsAppListSection[] };

export interface FlowResult {
  /** `false` means this turn is not the step machine's to handle -- an interactive tap arriving
   *  with no flow state to interpret it against (a stale button from an expired session), so the
   *  caller should fall back to whatever it does for a message with nothing else to go on. Free
   *  text with no state is never `false`: `runFlow` starts a fresh INTENT turn for it itself. */
  handled: boolean;
  /** State to persist -- `null` clears it (the flow finished, or is handing off). Absent only when
   *  `handled` is `false`, since nothing here changed. */
  nextState?: FlowState | null;
  outgoing?: FlowOutgoing;
}

function textOf(input: InboundWhatsAppInput): string | null {
  return input.kind === "text" ? input.text.trim() : null;
}

function idOf(input: InboundWhatsAppInput): string | null {
  return input.kind === "interactive" ? input.id : null;
}

// -------------------------------------------------------------------------------------------
// Small pure helpers
// -------------------------------------------------------------------------------------------

/** `2026-09-29` plus `days` calendar days -- calendar arithmetic only, deliberately not a timezone
 *  conversion: `todayInClinic` already gave us a clinic-local calendar date, and stepping through
 *  calendar days does not need the clinic's offset applied a second time. */
function addDaysIso(iso: string, days: number): string {
  const [year, month, day] = iso.split("-").map(Number) as [number, number, number];
  const asDate = new Date(Date.UTC(year, month - 1, day));
  asDate.setUTCDate(asDate.getUTCDate() + days);
  return asDate.toISOString().slice(0, 10);
}

function dateRowLabel(iso: string, lang: Lang): string {
  const asDate = new Date(`${iso}T00:00:00Z`);
  const locale = lang === "ar" ? "ar-EG" : "en-GB";
  return new Intl.DateTimeFormat(locale, { timeZone: "UTC", weekday: "short", day: "numeric", month: "short" }).format(asDate);
}

function timeOnly(clinicLocalTime: string): string {
  // formatInClinicTime returns "YYYY-MM-DD HH:MM" -- the slot list only needs the clock half, the
  // date is already the list's own heading.
  return clinicLocalTime.split(" ")[1] ?? clinicLocalTime;
}

/** A tiny pre-pass for the handful of relative-date words a patient is likely to type instead of a
 *  literal date, in either language -- resolved against the clinic's own calendar before falling
 *  through to `parseFlexibleDate`'s literal formats. Anything this does not recognise passes through
 *  unchanged, so a genuine "12-10-2026" is untouched by it. */
function normaliseRelativeDate(text: string, timezone: string): string {
  const trimmed = text.trim();
  const today = todayInClinic(timezone);
  const todayWords = ["اليوم", "النهاردة", "النهارده", "today"];
  const tomorrowWords = ["بكرة", "بكره", "غدا", "غداً", "tomorrow"];
  if (todayWords.some((w) => trimmed === w)) return today;
  if (tomorrowWords.some((w) => trimmed === w)) return addDaysIso(today, 1);
  return trimmed;
}

function pageSlots(slots: { iso: string; token: string; label: string }[], page: number) {
  const start = page * SLOTS_PER_PAGE;
  const pageItems = slots.slice(start, start + SLOTS_PER_PAGE);
  const hasMore = start + SLOTS_PER_PAGE < slots.length;
  return { pageItems, hasMore };
}

function slotRowId(indexOnPage: number): string {
  return `s${indexOnPage + 1}`;
}

// -------------------------------------------------------------------------------------------
// Intent classification and off-script fallback -- the model's only two jobs in this file
// -------------------------------------------------------------------------------------------

const BOOKING_WORDS = ["حجز", "احجز", "أحجز", "ميعاد", "موعد", "مواعيد", "book", "appointment", "schedule"];
const COMPLAINT_WORDS = ["شكو", "اشتكي", "مشكلة", "بلاغ", "complain", "complaint", "issue", "problem"];

/** Keyword-first on purpose: instant, free, and right often enough that a GPT round trip would only
 *  add latency to the common case. Only a message that matches neither list pays for one -- and even
 *  then, a failed or ambiguous call just falls through to the menu, never silently misroutes. */
async function classifyIntent(text: string): Promise<Intent | null> {
  const lower = text.toLowerCase();
  if (COMPLAINT_WORDS.some((w) => lower.includes(w))) return "complaint";
  if (BOOKING_WORDS.some((w) => lower.includes(w))) return "booking";
  if (text.length < 6) return null; // "hi", "ازيك" and the like are not worth a GPT call either.

  try {
    const completion = await callGpt({
      input: [{ role: "user", content: text }],
      tools: [],
      instructions:
        'Classify the patient\'s message as one of exactly: "BOOKING" (wants to book, reschedule, or ask about an ' +
        'appointment), "COMPLAINT" (wants to report a problem or complain), or "UNCLEAR". Reply with that one word ' +
        "and nothing else.",
    });
    const word = completion.outputText?.trim().toUpperCase();
    if (word === "BOOKING") return "booking";
    if (word === "COMPLAINT") return "complaint";
    return null;
  } catch (error) {
    console.error("WhatsApp flow: intent classification call failed", error);
    return null;
  }
}

/** Answers a question asked mid-step without ever letting the model touch a booking or a complaint
 *  -- no tools offered, nothing it says is treated as fact by any later step, and the reply is
 *  always followed by re-asking whatever the step already needed. A failed call still returns a
 *  reply (the neutral nudge), because a step with a pending question cannot be left with nothing to
 *  send back. */
async function offScriptReply(text: string, lang: Lang): Promise<string> {
  try {
    const completion = await callGpt({
      input: [{ role: "user", content: text }],
      tools: [],
      instructions:
        `You are a clinic's WhatsApp assistant. The patient just asked something off-script while in the middle of ` +
        `a booking or complaint flow that is driven by buttons, not by you. Answer briefly (2 sentences at most) in ` +
        `${lang === "ar" ? "Egyptian Arabic" : "English"}. Never invent clinic facts (hours, prices, doctor ` +
        `availability) you were not told here -- if asked, say you're not sure and that the desk can confirm. Do ` +
        "not mention booking, appointments, or complaints yourself -- the app adds its own reminder after your reply.",
    });
    return completion.outputText?.trim() || T.pleaseUseButtons(lang);
  } catch (error) {
    console.error("WhatsApp flow: off-script reply call failed", error);
    return T.pleaseUseButtons(lang);
  }
}

// -------------------------------------------------------------------------------------------
// The entry point
// -------------------------------------------------------------------------------------------

export async function runFlow(ctx: FlowContext): Promise<FlowResult> {
  const { client } = ctx;

  if (ctx.state === null) {
    if (ctx.input.kind === "interactive") {
      // A tap with no state to interpret it against -- almost always a button on a session that
      // has since gone idle and been reset. Not this file's to guess at; the caller decides what a
      // message with nothing else to go on gets.
      if (!ctx.isNewSession) return { handled: false };
      // A brand-new session that somehow opens on a tap (a forwarded message, a client replay) --
      // treat it exactly like free text would be treated: show the menu.
      return beginTurn(ctx, "ar", null);
    }
    const text = textOf(ctx.input) ?? "";
    const lang = detectLang(text);
    return beginTurn(ctx, lang, text);
  }

  switch (ctx.state.step) {
    case "INTENT":
      return stepIntent(ctx, ctx.state);
    case "IDENTITY_PICK":
      return stepIdentityPick(ctx, ctx.state);
    case "IDENTITY_YESNO":
      return stepIdentityYesNo(ctx, ctx.state);
    case "PHONE_CHOICE":
      return stepPhoneChoice(ctx, ctx.state);
    case "PHONE_ASK":
      return stepPhoneAsk(ctx, ctx.state);
    case "NAME_ASK":
      return stepNameAsk(ctx, ctx.state);
    case "BOOKING_DOCTOR":
      return stepBookingDoctor(ctx, ctx.state);
    case "BOOKING_SERVICE":
      return stepBookingService(ctx, ctx.state);
    case "BOOKING_DATE":
      return stepBookingDate(ctx, ctx.state);
    case "BOOKING_DATE_FREE":
      return stepBookingDateFree(ctx, ctx.state);
    case "BOOKING_SLOT":
      return stepBookingSlot(ctx, ctx.state);
    case "BOOKING_CONFIRM":
      return stepBookingConfirm(ctx, ctx.state);
    case "COMPLAINT_TEXT":
      return stepComplaintText(ctx, ctx.state);
    case "COMPLAINT_CONFIRM":
      return stepComplaintConfirm(ctx, ctx.state);
  }
  // Exhaustive switch above -- every FlowState step is handled. Satisfies noImplicitReturns without
  // a `never` cast that would hide a future unhandled step as a silent fall-through instead of a
  // compile error.
  return { handled: false };
}

/** New session or freshly finished flow, either way starting from nothing. `openingText` is the
 *  patient's own words if this turn is free text -- classified for intent so a clear opener skips
 *  straight past the menu -- or `null` for an interactive tap with no state (shows the menu). */
async function beginTurn(ctx: FlowContext, lang: Lang, openingText: string | null): Promise<FlowResult> {
  const welcomeLine = ctx.isNewSession ? `${T.welcome(lang, ctx.tenant.clinicName)}\n\n` : "";

  const intent = openingText === null ? null : await classifyIntent(openingText);
  if (intent === null) {
    return {
      handled: true,
      nextState: { step: "INTENT", lang },
      outgoing: {
        kind: "buttons",
        body: `${welcomeLine}${T.intentQuestion(lang)}`,
        buttons: [
          { id: "intent_booking", title: T.intentBooking(lang) },
          { id: "intent_complaint", title: T.intentComplaint(lang) },
        ],
      },
    };
  }

  return beginIdentity(ctx, lang, intent, welcomeLine);
}

async function stepIntent(ctx: FlowContext, state: Extract<FlowState, { step: "INTENT" }>): Promise<FlowResult> {
  const id = idOf(ctx.input);
  if (id === "intent_booking") return beginIdentity(ctx, state.lang, "booking", "");
  if (id === "intent_complaint") return beginIdentity(ctx, state.lang, "complaint", "");

  const text = textOf(ctx.input);
  if (text !== null) {
    const intent = await classifyIntent(text);
    if (intent !== null) return beginIdentity(ctx, state.lang, intent, "");
  }

  return {
    handled: true,
    nextState: state,
    outgoing: {
      kind: "buttons",
      body: T.intentUnclear(state.lang),
      buttons: [
        { id: "intent_booking", title: T.intentBooking(state.lang) },
        { id: "intent_complaint", title: T.intentComplaint(state.lang) },
      ],
    },
  };
}

// -------------------------------------------------------------------------------------------
// Identity: the same sub-flow whether the intent is booking or a complaint
// -------------------------------------------------------------------------------------------

async function beginIdentity(ctx: FlowContext, lang: Lang, intent: Intent, prefix: string): Promise<FlowResult> {
  const phoneE164 = ctx.phoneE164;
  const found = await ctx.client.findPatientsByPhone(phoneE164);

  if (!found.ok) return errorResult(lang, prefix);

  if (found.value.patients.length === 0) {
    return {
      handled: true,
      nextState: { step: "PHONE_CHOICE", lang, intent },
      outgoing: {
        kind: "buttons",
        body: `${prefix}${T.phoneChoiceQuestion(lang)}`,
        buttons: [
          { id: "phone_same", title: T.phoneChoiceThisNumber(lang) },
          { id: "phone_other", title: T.phoneChoiceOtherNumber(lang) },
        ],
      },
    };
  }

  if (found.value.patients.length === 1) {
    const only = found.value.patients[0]!;
    return {
      handled: true,
      nextState: { step: "IDENTITY_YESNO", lang, intent, phoneE164, patientId: only.patientId, patientName: only.displayName },
      outgoing: {
        kind: "buttons",
        body: `${prefix}${T.identityConfirmSingle(lang, only.displayName, phoneE164)}`,
        buttons: [
          { id: "yn_yes", title: T.yes(lang) },
          { id: "yn_no", title: T.no(lang) },
        ],
      },
    };
  }

  const options = found.value.patients.map((p) => ({ patientId: p.patientId, name: p.displayName }));
  const rows = options.map((option) => ({ id: `pat_${option.patientId}`, title: option.name.slice(0, 24) }));
  rows.push({ id: "pat_other", title: T.identityOptionSomeoneElse(lang).slice(0, 24) });

  return {
    handled: true,
    nextState: { step: "IDENTITY_PICK", lang, intent, phoneE164, options },
    outgoing: {
      kind: "list",
      body: `${prefix}${T.identityConfirmMultiple(lang)}`,
      buttonLabel: T.bookingListOpen(lang),
      sections: [{ title: T.identityConfirmMultiple(lang).slice(0, 24), rows }],
    },
  };
}

async function stepIdentityYesNo(ctx: FlowContext, state: Extract<FlowState, { step: "IDENTITY_YESNO" }>): Promise<FlowResult> {
  const id = idOf(ctx.input);
  if (id === "yn_yes") {
    return afterIdentity(ctx, state.lang, state.intent, { patientId: state.patientId, patientName: state.patientName });
  }
  if (id === "yn_no") {
    return {
      handled: true,
      nextState: { step: "NAME_ASK", lang: state.lang, intent: state.intent, phoneE164: state.phoneE164 },
      outgoing: { kind: "text", text: T.nameAskQuestion(state.lang) },
    };
  }
  return offScriptThenRepeat(ctx, state.lang, {
    kind: "buttons",
    body: T.identityConfirmSingle(state.lang, state.patientName, state.phoneE164),
    buttons: [
      { id: "yn_yes", title: T.yes(state.lang) },
      { id: "yn_no", title: T.no(state.lang) },
    ],
  });
}

async function stepIdentityPick(ctx: FlowContext, state: Extract<FlowState, { step: "IDENTITY_PICK" }>): Promise<FlowResult> {
  const id = idOf(ctx.input);
  if (id === "pat_other") {
    return {
      handled: true,
      nextState: { step: "NAME_ASK", lang: state.lang, intent: state.intent, phoneE164: state.phoneE164 },
      outgoing: { kind: "text", text: T.nameAskQuestion(state.lang) },
    };
  }
  const picked = id?.startsWith("pat_") ? state.options.find((o) => `pat_${o.patientId}` === id) : undefined;
  if (picked !== undefined) {
    return afterIdentity(ctx, state.lang, state.intent, { patientId: picked.patientId, patientName: picked.name });
  }

  const rows = state.options.map((option) => ({ id: `pat_${option.patientId}`, title: option.name.slice(0, 24) }));
  rows.push({ id: "pat_other", title: T.identityOptionSomeoneElse(state.lang).slice(0, 24) });
  return offScriptThenRepeat(ctx, state.lang, {
    kind: "list",
    body: T.identityConfirmMultiple(state.lang),
    buttonLabel: T.bookingListOpen(state.lang),
    sections: [{ title: T.identityConfirmMultiple(state.lang).slice(0, 24), rows }],
  });
}

async function stepPhoneChoice(ctx: FlowContext, state: Extract<FlowState, { step: "PHONE_CHOICE" }>): Promise<FlowResult> {
  const id = idOf(ctx.input);
  if (id === "phone_same") {
    return {
      handled: true,
      nextState: { step: "NAME_ASK", lang: state.lang, intent: state.intent, phoneE164: ctx.phoneE164 },
      outgoing: { kind: "text", text: T.nameAskQuestion(state.lang) },
    };
  }
  if (id === "phone_other") {
    return {
      handled: true,
      nextState: { step: "PHONE_ASK", lang: state.lang, intent: state.intent },
      outgoing: { kind: "text", text: T.phoneAskQuestion(state.lang) },
    };
  }
  return offScriptThenRepeat(ctx, state.lang, {
    kind: "buttons",
    body: T.phoneChoiceQuestion(state.lang),
    buttons: [
      { id: "phone_same", title: T.phoneChoiceThisNumber(state.lang) },
      { id: "phone_other", title: T.phoneChoiceOtherNumber(state.lang) },
    ],
  });
}

async function stepPhoneAsk(ctx: FlowContext, state: Extract<FlowState, { step: "PHONE_ASK" }>): Promise<FlowResult> {
  const text = textOf(ctx.input);
  const normalised = text === null ? null : normalisePhone(text, EGYPT);
  if (normalised === null) {
    return { handled: true, nextState: state, outgoing: { kind: "text", text: T.phoneInvalid(state.lang) } };
  }
  // A different number the patient names is their contact phone only -- the WhatsApp sender stays
  // the conversation's own contact (whatsapp-conversation.ts's Contact row is never touched here).
  // Re-running identity against it, without offering the phone choice a second time, covers the
  // case where that other number *also* already has patients on file.
  return beginIdentityForKnownPhone(ctx, state.lang, state.intent, normalised);
}

/** Identical to `beginIdentity` except the phone to check is not `ctx.phoneE164` -- used only from
 *  `stepPhoneAsk`, once the patient has named a different number to book under. */
async function beginIdentityForKnownPhone(ctx: FlowContext, lang: Lang, intent: Intent, phoneE164: string): Promise<FlowResult> {
  const found = await ctx.client.findPatientsByPhone(phoneE164);
  if (!found.ok) return errorResult(lang, "");

  if (found.value.patients.length === 0) {
    return {
      handled: true,
      nextState: { step: "NAME_ASK", lang, intent, phoneE164 },
      outgoing: { kind: "text", text: T.nameAskQuestion(lang) },
    };
  }
  if (found.value.patients.length === 1) {
    const only = found.value.patients[0]!;
    return {
      handled: true,
      nextState: { step: "IDENTITY_YESNO", lang, intent, phoneE164, patientId: only.patientId, patientName: only.displayName },
      outgoing: {
        kind: "buttons",
        body: T.identityConfirmSingle(lang, only.displayName, phoneE164),
        buttons: [
          { id: "yn_yes", title: T.yes(lang) },
          { id: "yn_no", title: T.no(lang) },
        ],
      },
    };
  }
  const options = found.value.patients.map((p) => ({ patientId: p.patientId, name: p.displayName }));
  const rows = options.map((option) => ({ id: `pat_${option.patientId}`, title: option.name.slice(0, 24) }));
  rows.push({ id: "pat_other", title: T.identityOptionSomeoneElse(lang).slice(0, 24) });
  return {
    handled: true,
    nextState: { step: "IDENTITY_PICK", lang, intent, phoneE164, options },
    outgoing: {
      kind: "list",
      body: T.identityConfirmMultiple(lang),
      buttonLabel: T.bookingListOpen(lang),
      sections: [{ title: T.identityConfirmMultiple(lang).slice(0, 24), rows }],
    },
  };
}

async function stepNameAsk(ctx: FlowContext, state: Extract<FlowState, { step: "NAME_ASK" }>): Promise<FlowResult> {
  const text = textOf(ctx.input)?.trim();
  if (!text || text.length < 2) {
    return { handled: true, nextState: state, outgoing: { kind: "text", text: T.nameInvalid(state.lang) } };
  }
  const created = await ctx.client.createProvisionalPatient({ fullNameAr: text, phoneE164: state.phoneE164 });
  if (!created.ok) return errorResult(state.lang, "");
  return afterIdentity(ctx, state.lang, state.intent, { patientId: created.value.patientId, patientName: created.value.displayName });
}

/** Identity resolved -- branch into whichever intent this turn started with. */
async function afterIdentity(ctx: FlowContext, lang: Lang, intent: Intent, person: Person): Promise<FlowResult> {
  if (intent === "complaint") {
    return {
      handled: true,
      nextState: { step: "COMPLAINT_TEXT", lang, ...person },
      outgoing: { kind: "text", text: T.complaintAskQuestion(lang) },
    };
  }
  return beginBookingDoctor(ctx, lang, person);
}

// -------------------------------------------------------------------------------------------
// Booking
// -------------------------------------------------------------------------------------------

async function beginBookingDoctor(ctx: FlowContext, lang: Lang, person: Person): Promise<FlowResult> {
  const doctors = await ctx.client.listDoctors();
  if (!doctors.ok) return errorResult(lang, "");
  if (doctors.value.doctors.length === 0) return errorResult(lang, "");

  if (doctors.value.doctors.length === 1) {
    const only = doctors.value.doctors[0]!;
    return beginBookingService(ctx, lang, person, { id: only.id, name: only.fullName });
  }

  const rows = doctors.value.doctors.map((d) => ({ id: `doc_${d.id}`, title: d.fullName.slice(0, 24), description: d.specialty.slice(0, 72) }));
  return {
    handled: true,
    nextState: { step: "BOOKING_DOCTOR", lang, ...person },
    outgoing: { kind: "list", body: T.bookingDoctorQuestion(lang), buttonLabel: T.bookingListOpen(lang), sections: [{ title: T.bookingDoctorQuestion(lang).slice(0, 24), rows }] },
  };
}

async function stepBookingDoctor(ctx: FlowContext, state: Extract<FlowState, { step: "BOOKING_DOCTOR" }>): Promise<FlowResult> {
  const id = idOf(ctx.input);
  if (id?.startsWith("doc_")) {
    const doctors = await ctx.client.listDoctors();
    if (!doctors.ok) return errorResult(state.lang, "");
    const picked = doctors.value.doctors.find((d) => d.id === id.slice(4));
    if (picked !== undefined) {
      return beginBookingService(ctx, state.lang, { patientId: state.patientId, patientName: state.patientName }, { id: picked.id, name: picked.fullName });
    }
  }
  const doctors = await ctx.client.listDoctors();
  const rows = doctors.ok ? doctors.value.doctors.map((d) => ({ id: `doc_${d.id}`, title: d.fullName.slice(0, 24), description: d.specialty.slice(0, 72) })) : [];
  return offScriptThenRepeat(ctx, state.lang, { kind: "list", body: T.bookingDoctorQuestion(state.lang), buttonLabel: T.bookingListOpen(state.lang), sections: [{ title: T.bookingDoctorQuestion(state.lang).slice(0, 24), rows }] });
}

async function beginBookingService(ctx: FlowContext, lang: Lang, person: Person, doctor: { id: string; name: string }): Promise<FlowResult> {
  const services = await ctx.client.listServices();
  if (!services.ok) return errorResult(lang, "");
  if (services.value.services.length === 0) return errorResult(lang, "");

  if (services.value.services.length === 1) {
    const only = services.value.services[0]!;
    return beginBookingDate(ctx, lang, person, doctor, { id: only.id, name: lang === "ar" ? only.nameAr : only.nameEn });
  }

  const rows = services.value.services.map((s) => ({ id: `svc_${s.id}`, title: (lang === "ar" ? s.nameAr : s.nameEn).slice(0, 24) }));
  return {
    handled: true,
    nextState: { step: "BOOKING_SERVICE", lang, doctorId: doctor.id, doctorName: doctor.name, ...person },
    outgoing: { kind: "list", body: T.bookingServiceQuestion(lang), buttonLabel: T.bookingListOpen(lang), sections: [{ title: T.bookingServiceQuestion(lang).slice(0, 24), rows }] },
  };
}

async function stepBookingService(ctx: FlowContext, state: Extract<FlowState, { step: "BOOKING_SERVICE" }>): Promise<FlowResult> {
  const id = idOf(ctx.input);
  const person: Person = { patientId: state.patientId, patientName: state.patientName };
  const doctor = { id: state.doctorId, name: state.doctorName };
  if (id?.startsWith("svc_")) {
    const services = await ctx.client.listServices();
    if (!services.ok) return errorResult(state.lang, "");
    const picked = services.value.services.find((s) => s.id === id.slice(4));
    if (picked !== undefined) {
      return beginBookingDate(ctx, state.lang, person, doctor, { id: picked.id, name: state.lang === "ar" ? picked.nameAr : picked.nameEn });
    }
  }
  const services = await ctx.client.listServices();
  const rows = services.ok ? services.value.services.map((s) => ({ id: `svc_${s.id}`, title: (state.lang === "ar" ? s.nameAr : s.nameEn).slice(0, 24) })) : [];
  return offScriptThenRepeat(ctx, state.lang, { kind: "list", body: T.bookingServiceQuestion(state.lang), buttonLabel: T.bookingListOpen(state.lang), sections: [{ title: T.bookingServiceQuestion(state.lang).slice(0, 24), rows }] });
}

async function beginBookingDate(
  ctx: FlowContext,
  lang: Lang,
  person: Person,
  doctor: { id: string; name: string },
  service: { id: string; name: string },
): Promise<FlowResult> {
  const dates = await findUpcomingDates(ctx.client, doctor.id, service.id, ctx.tenant.timezone);
  if (dates.length === 0) {
    return { handled: true, nextState: null, outgoing: { kind: "text", text: T.bookingNoDatesAhead(lang) } };
  }

  const rows = dates.map((iso) => ({ id: `date_${iso}`, title: dateRowLabel(iso, lang) }));
  rows.push({ id: "date_other", title: T.bookingDateOther(lang) });

  return {
    handled: true,
    nextState: { step: "BOOKING_DATE", lang, doctorId: doctor.id, doctorName: doctor.name, serviceId: service.id, serviceName: service.name, ...person },
    outgoing: { kind: "list", body: T.bookingDateQuestion(lang), buttonLabel: T.bookingListOpen(lang), sections: [{ title: T.bookingDateQuestion(lang).slice(0, 24), rows }] },
  };
}

/** Probes forward day by day (sequential, not parallel -- a chat reply has no reason to fire twenty
 *  concurrent requests at the slot engine) until `DATES_WANTED` open days are found or the horizon
 *  runs out. Answers "be aware of the doctor's free days" (the founder's Q7) without a dedicated
 *  bot-side endpoint: a day with nothing bookable simply never makes the list. */
async function findUpcomingDates(client: BotApiClient, doctorId: string, serviceId: string, timezone: string): Promise<string[]> {
  const dates: string[] = [];
  const today = todayInClinic(timezone);
  for (let offset = 0; offset < DATE_SEARCH_HORIZON_DAYS && dates.length < DATES_WANTED; offset++) {
    const date = offset === 0 ? today : addDaysIso(today, offset);
    const result = await client.listSlots({ doctorId, serviceId, date });
    if (result.ok && result.value.slots.length > 0) dates.push(date);
  }
  return dates;
}

async function stepBookingDate(ctx: FlowContext, state: Extract<FlowState, { step: "BOOKING_DATE" }>): Promise<FlowResult> {
  const id = idOf(ctx.input);
  if (id === "date_other") {
    return {
      handled: true,
      nextState: { step: "BOOKING_DATE_FREE", lang: state.lang, doctorId: state.doctorId, doctorName: state.doctorName, serviceId: state.serviceId, serviceName: state.serviceName, patientId: state.patientId, patientName: state.patientName },
      outgoing: { kind: "text", text: T.bookingDateFreeAsk(state.lang) },
    };
  }
  if (id?.startsWith("date_")) {
    return listSlotsForDate(ctx, state, id.slice(5));
  }

  const text = textOf(ctx.input);
  if (text !== null) {
    const parsed = parseFlexibleDate(normaliseRelativeDate(text, ctx.tenant.timezone));
    if (parsed !== null) {
      if (parsed < todayInClinic(ctx.tenant.timezone)) {
        return { handled: true, nextState: state, outgoing: { kind: "text", text: T.bookingDatePast(state.lang) } };
      }
      return listSlotsForDate(ctx, state, parsed);
    }
  }

  return offScriptThenRepeat(ctx, state.lang, await bookingDateOutgoing(ctx, state));
}

async function stepBookingDateFree(ctx: FlowContext, state: Extract<FlowState, { step: "BOOKING_DATE_FREE" }>): Promise<FlowResult> {
  const text = textOf(ctx.input);
  const parsed = text === null ? null : parseFlexibleDate(normaliseRelativeDate(text, ctx.tenant.timezone));
  if (parsed === null) {
    return { handled: true, nextState: state, outgoing: { kind: "text", text: T.bookingDateInvalid(state.lang) } };
  }
  if (parsed < todayInClinic(ctx.tenant.timezone)) {
    return { handled: true, nextState: state, outgoing: { kind: "text", text: T.bookingDatePast(state.lang) } };
  }
  return listSlotsForDate(ctx, state, parsed);
}

/** Rebuilds the date list for re-prompting `BOOKING_DATE` after an off-script detour -- the list
 *  itself is cheap to recompute and storing it a second time in state would only risk it going
 *  stale between the original send and the repeat. */
async function bookingDateOutgoing(ctx: FlowContext, state: Extract<FlowState, { step: "BOOKING_DATE" }>): Promise<FlowOutgoing> {
  const dates = await findUpcomingDates(ctx.client, state.doctorId, state.serviceId, ctx.tenant.timezone);
  const rows = dates.map((iso) => ({ id: `date_${iso}`, title: dateRowLabel(iso, state.lang) }));
  rows.push({ id: "date_other", title: T.bookingDateOther(state.lang) });
  return { kind: "list", body: T.bookingDateQuestion(state.lang), buttonLabel: T.bookingListOpen(state.lang), sections: [{ title: T.bookingDateQuestion(state.lang).slice(0, 24), rows }] };
}

async function listSlotsForDate(
  ctx: FlowContext,
  state: { lang: Lang; doctorId: string; doctorName: string; serviceId: string; serviceName: string; patientId: string; patientName: string },
  date: string,
): Promise<FlowResult> {
  const result = await ctx.client.listSlots({ doctorId: state.doctorId, serviceId: state.serviceId, date });
  if (!result.ok) return errorResult(state.lang, "");

  const now = new Date();
  const slots = result.value.slots
    .filter((slot) => new Date(slot.start) > now)
    .map((slot) => ({ iso: slot.start, token: slot.token, label: timeOnly(formatInClinicTime(new Date(slot.start), ctx.tenant.timezone)) }));

  if (slots.length === 0) {
    return {
      handled: true,
      nextState: { step: "BOOKING_DATE", lang: state.lang, doctorId: state.doctorId, doctorName: state.doctorName, serviceId: state.serviceId, serviceName: state.serviceName, patientId: state.patientId, patientName: state.patientName },
      outgoing: { kind: "text", text: T.bookingNoSlotsOnDate(state.lang) },
    };
  }

  return sendSlotPage(state, date, slots, 0);
}

function sendSlotPage(
  state: { lang: Lang; doctorId: string; doctorName: string; serviceId: string; serviceName: string; patientId: string; patientName: string },
  date: string,
  slots: { iso: string; token: string; label: string }[],
  page: number,
): FlowResult {
  const { pageItems, hasMore } = pageSlots(slots, page);
  const rows = pageItems.map((slot, index) => ({ id: slotRowId(index), title: slot.label }));
  if (hasMore) rows.push({ id: "more", title: T.bookingSlotMore(state.lang) });

  return {
    handled: true,
    nextState: {
      step: "BOOKING_SLOT",
      lang: state.lang,
      doctorId: state.doctorId,
      doctorName: state.doctorName,
      serviceId: state.serviceId,
      serviceName: state.serviceName,
      patientId: state.patientId,
      patientName: state.patientName,
      date,
      slots,
      page,
    },
    outgoing: { kind: "list", body: T.bookingSlotQuestion(state.lang), buttonLabel: T.bookingListOpen(state.lang), sections: [{ title: dateRowLabel(date, state.lang), rows }] },
  };
}

async function stepBookingSlot(ctx: FlowContext, state: Extract<FlowState, { step: "BOOKING_SLOT" }>): Promise<FlowResult> {
  const id = idOf(ctx.input);
  if (id === "more") {
    return Promise.resolve(sendSlotPage(state, state.date, state.slots, state.page + 1));
  }
  if (id !== null && /^s[1-9]$/.test(id)) {
    const indexOnPage = Number(id.slice(1)) - 1;
    const { pageItems } = pageSlots(state.slots, state.page);
    const picked = pageItems[indexOnPage];
    if (picked !== undefined) {
      return {
        handled: true,
        nextState: {
          step: "BOOKING_CONFIRM",
          lang: state.lang,
          doctorId: state.doctorId,
          doctorName: state.doctorName,
          serviceId: state.serviceId,
          serviceName: state.serviceName,
          patientId: state.patientId,
          patientName: state.patientName,
          date: state.date,
          slotIso: picked.iso,
          slotLabel: picked.label,
          token: picked.token,
        },
        outgoing: {
          kind: "buttons",
          body: T.bookingConfirmQuestion(state.lang, state.doctorName, state.serviceName, dateRowLabel(state.date, state.lang), picked.label, state.patientName),
          buttons: [
            { id: "yn_yes", title: T.bookingConfirmButton(state.lang) },
            { id: "yn_no", title: T.bookingChangeButton(state.lang) },
          ],
        },
      };
    }
  }
  const { pageItems, hasMore } = pageSlots(state.slots, state.page);
  const rows = pageItems.map((slot, index) => ({ id: slotRowId(index), title: slot.label }));
  if (hasMore) rows.push({ id: "more", title: T.bookingSlotMore(state.lang) });
  return offScriptThenRepeat(ctx, state.lang, { kind: "list", body: T.bookingSlotQuestion(state.lang), buttonLabel: T.bookingListOpen(state.lang), sections: [{ title: dateRowLabel(state.date, state.lang), rows }] });
}

async function stepBookingConfirm(ctx: FlowContext, state: Extract<FlowState, { step: "BOOKING_CONFIRM" }>): Promise<FlowResult> {
  const id = idOf(ctx.input);
  if (id === "yn_no") {
    return beginBookingDoctor(ctx, state.lang, { patientId: state.patientId, patientName: state.patientName });
  }
  if (id === "yn_yes") {
    return confirmBooking(ctx, state);
  }
  return offScriptThenRepeat(ctx, state.lang, {
    kind: "buttons",
    body: T.bookingConfirmQuestion(state.lang, state.doctorName, state.serviceName, dateRowLabel(state.date, state.lang), state.slotLabel, state.patientName),
    buttons: [
      { id: "yn_yes", title: T.bookingConfirmButton(state.lang) },
      { id: "yn_no", title: T.bookingChangeButton(state.lang) },
    ],
  });
}

async function confirmBooking(ctx: FlowContext, state: Extract<FlowState, { step: "BOOKING_CONFIRM" }>): Promise<FlowResult> {
  let result = await ctx.client.bookAppointment({ patientId: state.patientId, slotToken: state.token, consentMessageId: ctx.inboundExternalMessageId });

  // The token was minted when the list was shown; if the patient took a while, retry once against
  // a freshly re-listed offer for the same date and time -- never against a token the model or the
  // patient supplied, only ever against what the API itself just re-confirmed is bookable.
  if (!result.ok && (result.code === "INVALID_TOKEN" || result.code === "EXPIRED_TOKEN")) {
    const refreshed = await ctx.client.listSlots({ doctorId: state.doctorId, serviceId: state.serviceId, date: state.date });
    const match = refreshed.ok ? refreshed.value.slots.find((slot) => slot.start === state.slotIso) : undefined;
    if (match !== undefined) {
      result = await ctx.client.bookAppointment({ patientId: state.patientId, slotToken: match.token, consentMessageId: ctx.inboundExternalMessageId });
    }
  }

  if (!result.ok) {
    if (result.code === "SLOT_TAKEN" || result.code === "INVALID_TOKEN" || result.code === "EXPIRED_TOKEN") {
      return listSlotsForDate(ctx, state, state.date).then((slotResult) => ({
        ...slotResult,
        outgoing: slotResult.outgoing?.kind === "text" ? slotResult.outgoing : prependText(slotResult.outgoing, T.bookingSlotTaken(state.lang)),
      }));
    }
    return errorResult(state.lang, "");
  }

  return {
    handled: true,
    nextState: null,
    outgoing: { kind: "text", text: T.bookingSuccess(state.lang, state.doctorName, dateRowLabel(state.date, state.lang), state.slotLabel) },
  };
}

function prependText(outgoing: FlowOutgoing | undefined, line: string): FlowOutgoing | undefined {
  if (outgoing === undefined) return outgoing;
  if (outgoing.kind === "text") return { kind: "text", text: `${line}\n\n${outgoing.text}` };
  return { ...outgoing, body: `${line}\n\n${outgoing.body}` };
}

// -------------------------------------------------------------------------------------------
// Complaint
// -------------------------------------------------------------------------------------------

async function stepComplaintText(ctx: FlowContext, state: Extract<FlowState, { step: "COMPLAINT_TEXT" }>): Promise<FlowResult> {
  const text = textOf(ctx.input)?.trim();
  if (!text || text.length < 5) {
    return { handled: true, nextState: state, outgoing: { kind: "text", text: T.complaintTooShort(state.lang) } };
  }
  return {
    handled: true,
    nextState: { step: "COMPLAINT_CONFIRM", lang: state.lang, patientId: state.patientId, patientName: state.patientName, text },
    outgoing: {
      kind: "buttons",
      body: T.complaintConfirmQuestion(state.lang, text),
      buttons: [
        { id: "yn_yes", title: T.complaintConfirmButton(state.lang) },
        { id: "yn_no", title: T.complaintEditButton(state.lang) },
      ],
    },
  };
}

async function stepComplaintConfirm(ctx: FlowContext, state: Extract<FlowState, { step: "COMPLAINT_CONFIRM" }>): Promise<FlowResult> {
  const id = idOf(ctx.input);
  if (id === "yn_no") {
    return {
      handled: true,
      nextState: { step: "COMPLAINT_TEXT", lang: state.lang, patientId: state.patientId, patientName: state.patientName },
      outgoing: { kind: "text", text: T.complaintEditAsk(state.lang) },
    };
  }
  if (id === "yn_yes") {
    const result = await ctx.client.createComplaint({ patientId: state.patientId, description: state.text, consentMessageId: ctx.inboundExternalMessageId });
    if (!result.ok) return errorResult(state.lang, "");
    return { handled: true, nextState: null, outgoing: { kind: "text", text: T.complaintSuccess(state.lang, result.value.referenceNumber) } };
  }
  return offScriptThenRepeat(ctx, state.lang, {
    kind: "buttons",
    body: T.complaintConfirmQuestion(state.lang, state.text),
    buttons: [
      { id: "yn_yes", title: T.complaintConfirmButton(state.lang) },
      { id: "yn_no", title: T.complaintEditButton(state.lang) },
    ],
  });
}

// -------------------------------------------------------------------------------------------
// Shared
// -------------------------------------------------------------------------------------------

/** Free text arrived at a step that expects a tap. Answered by the model (never touching booking or
 *  complaint state), then the same question is repeated unchanged -- the patient's place in the
 *  flow never moves because of an off-script message. */
async function offScriptThenRepeat(ctx: FlowContext, lang: Lang, repeat: FlowOutgoing): Promise<FlowResult> {
  const text = textOf(ctx.input);
  const state = ctx.state as FlowState; // present on every call site -- only reached from within a step handler.
  if (text === null) {
    return { handled: true, nextState: state, outgoing: repeat };
  }
  const answer = await offScriptReply(text, lang);
  const nudge = repeat.kind === "text" ? `${answer}\n\n${T.pleaseUseButtons(lang)}` : answer;
  return { handled: true, nextState: state, outgoing: prependText(repeat, nudge) ?? repeat };
}

function errorResult(lang: Lang, prefix: string): FlowResult {
  return { handled: true, nextState: null, outgoing: { kind: "text", text: `${prefix}${T.genericError(lang)}` } };
}
