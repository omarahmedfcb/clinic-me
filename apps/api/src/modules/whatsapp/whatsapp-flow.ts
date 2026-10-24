// The WhatsApp bot's step machine -- code decides which fixed-template question comes next, buttons
// and lists carry the answer back, and the model is used only for two narrow jobs: reading a typed
// date, and answering an off-script question without derailing the step the patient is mid-way
// through. The bot books appointments and nothing else (the patient's medical complaint is one
// question inside the booking). Every fact in a booking comes from a tool result or the patient's
// own tap or words, exactly the property SYSTEM_PROMPT (whatsapp-orchestrator.ts) already asked of
// the old all-GPT flow, now held by construction instead of by instruction.
//
// State lives in `Conversation.flowState` (schema.prisma), written and read only here. A tapped
// button's `id` is meaningful only against the specific step that offered it -- this file is the
// only place that interprets one, and it dispatches purely on `state.step`, never on the id alone.

import { normalisePhone } from "../auth/phone.ts";
import { callGpt } from "../webchat/gpt-client.ts";
import { dayPeriodInClinic, formatInClinicTime, parseFlexibleDate, todayInClinic, weekdayName } from "../../common/clinic-time.ts";
import type { BotApiClient } from "./bot-api-client.ts";
import { detectLang, formatPrice, T, type Lang } from "./whatsapp-flow-text.ts";
import { matchByName, pickByModel } from "./patient-name-match.ts";
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

interface Person {
  patientId: string;
  patientName: string;
  /** The medical complaint, asked right after identity and sent with the booking so it lands in the
   *  consultation's complaint field. Optional in the type only so a booking that was mid-way when
   *  this field was introduced can still finish; every new booking has it before the doctor step. */
  complaint?: string;
  /** Present when this "booking" is really an edit of an existing appointment (the reminder's
   *  "تعديل الموعد" button): the steps are the same ones, but the last one moves that appointment
   *  instead of creating a new one. Carried through every step with the rest of `Person`. */
  reschedule?: RescheduleTarget;
}

/** The appointment being edited, as it was when the patient tapped the button. */
export interface RescheduleTarget {
  appointmentId: string;
  /** ISO instant the appointment had at the tap -- compared again at the end, so an appointment the desk
   *  moved or cancelled in the meantime is never overwritten from a stale screen. */
  originalStart: string;
  /** "الأحد، 18 أكتوبر 10:30" -- shown on the confirm screen as the time being left. */
  fromLabel: string;
}

/** A patient may move one appointment this many times from WhatsApp; after that they cancel and rebook.
 *  Also checked when the reminder's edit button is tapped (reminder-reply.ts). */
export const MAX_PATIENT_RESCHEDULES = 2;
/** A complaint shorter than this is not an answer ("." or "ok") -- asked again, never skipped. */
const MIN_COMPLAINT_CHARS = 3;
/** The booking API accepts 2000; a patient's own words are kept to half that, plenty for a reason
 *  for the visit and short enough to read on the doctor's screen at a glance. */
const MAX_COMPLAINT_CHARS = 1000;

/** How many consecutive turns at the same step can go by with free text that neither a button tap,
 *  the keyword matcher, nor the model could resolve to a real option, before giving up and telling
 *  the patient to contact the clinic directly rather than looping them forever. Counts only genuine
 *  misses -- a step that resolves (by tap, by keyword, or by the model) always starts back at 0. */
const MAX_UNMATCHED_ATTEMPTS = 3;

/** Every shape `Conversation.flowState` can hold. Every step past IDENTITY carries `lang` and,
 *  once resolved, the patient and the medical complaint -- both are settled once per booking and
 *  never re-asked mid-way. `missCount` rides along on every variant via this intersection (TS
 *  distributes it across the union) rather than being repeated in each one -- `offScriptThenRepeat`
 *  is the only place that reads or writes it. */
type FlowStateBase = { missCount?: number };
export type FlowState = FlowStateBase &
  (
    | { step: "PHONE_CHOICE"; lang: Lang }
    | { step: "PHONE_ASK"; lang: Lang }
    | { step: "NAME_ASK"; lang: Lang; phoneE164: string }
    | ({ step: "BOOKING_COMPLAINT"; lang: Lang } & Person)
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
      /** "300 جنيه", shown on the confirm screen and in the success message. Absent when the service has no price. */
      priceLabel?: string;
    } & Person)
  );

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
   *  text with no state is never `false`: `runFlow` starts a fresh booking for it itself. */
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

const TODAY_WORDS = ["اليوم", "النهاردة", "النهارده", "today"];
const TOMORROW_WORDS = ["بكرة", "بكره", "غدا", "غداً", "tomorrow"];
/** Normalised (see `normaliseForMatch`) so "الأحد"/"الاحد" and "Sun"/"sunday" all match regardless
 *  of spelling or case -- a patient naming the day is only ever a courtesy alongside the date that
 *  follows, never checked against it, so there's nothing to gain from being strict about spelling. */
const WEEKDAY_NAMES = new Set(
  [
    "الاحد", "الاثنين", "الثلاثاء", "الاربعاء", "الخميس", "الجمعة", "السبت",
    "sunday", "sun", "monday", "mon", "tuesday", "tue", "tues",
    "wednesday", "wed", "thursday", "thu", "thurs", "friday", "fri", "saturday", "sat",
  ].map((w) => normaliseForMatch(w)),
);

/** A leading weekday name ("الاحد 5-10", "Sunday 12/10") is dropped, never checked against the date
 *  that follows -- a patient who names the wrong day for their own date still gets the date they
 *  typed, not a silent "correction" to a day they didn't ask for. Only ever strips one leading
 *  word, so a date that happens to start with something matching a weekday's normalised form in
 *  some other context is not at risk -- this only looks at the very first token. */
function stripLeadingWeekdayName(text: string): string {
  const firstSpace = text.indexOf(" ");
  if (firstSpace === -1) return text;
  const first = normaliseForMatch(text.slice(0, firstSpace));
  return WEEKDAY_NAMES.has(first) ? text.slice(firstSpace + 1).trim() : text;
}

/**
 * Everything `BOOKING_DATE`/`BOOKING_DATE_FREE` accept as a typed date, resolved against the
 * clinic's own calendar: relative words ("بكرة"/"tomorrow"), an optional leading weekday name
 * (dropped, see `stripLeadingWeekdayName`), a bare day-month with no year ("5-10" -- assumed this
 * year, rolled to next year if that date has already passed), and anything `parseFlexibleDate`
 * already handled (a full "D-M-YYYY" or ISO date). Returns an ISO date, or `null` if none of these
 * recognise it.
 */
function parseFlowDate(rawText: string, timezone: string): string | null {
  const today = todayInClinic(timezone);
  const trimmed = rawText.trim();
  if (TODAY_WORDS.some((w) => trimmed === w)) return today;
  if (TOMORROW_WORDS.some((w) => trimmed === w)) return addDaysIso(today, 1);

  const withoutWeekday = stripLeadingWeekdayName(trimmed);

  const noYearMatch = /^(\d{1,2})[-/](\d{1,2})$/.exec(withoutWeekday);
  if (noYearMatch !== null) {
    const [, day, month] = noYearMatch;
    const thisYear = Number(today.slice(0, 4));
    const paddedMonth = month!.padStart(2, "0");
    const paddedDay = day!.padStart(2, "0");
    const candidate = `${thisYear}-${paddedMonth}-${paddedDay}`;
    if (Number.isNaN(new Date(`${candidate}T00:00:00Z`).getTime())) return null;
    // Already past this year -- a patient typing "5-10" in November almost certainly means next
    // October, not one that's already gone by, so roll forward rather than reject outright.
    return candidate < today ? `${thisYear + 1}-${paddedMonth}-${paddedDay}` : candidate;
  }

  return parseFlexibleDate(withoutWeekday);
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
// Off-script fallback (and, further down, typed-date parsing) -- the model's only two jobs in this file
// -------------------------------------------------------------------------------------------

/** Exact-match only (via `normaliseForMatch`), deliberately not a substring check like
 *  `matchByKeyword` uses elsewhere: "شكرا" must be the *whole* message, not a word inside a longer
 *  one ("شكرا بس حابب أغير الميعاد" -- thanks, but I'd like to change the appointment -- is a real
 *  request and must not be swallowed as a closing remark because it happens to contain "شكرا"). */
/** Thanks and sign-offs, in the registers Egyptian patients actually use. Matched as whole words
 *  or phrases anywhere in a SHORT message ("حبيبي تسلم", "تسلم ايدك يا دكتور", "thanks a lot"), never
 *  as a substring of a longer word. */
const CLOSING_WORDS = [
  "شكرا", "شكرا ليك", "شكرا لك", "تسلم", "تسلم ايدك", "تسلملي", "يسلمو", "يسلموا", "متشكر", "متشكره", "ممنون", "ممنونه",
  "ربنا يخليك", "ربنا يكرمك", "ربنا يباركلك", "الله يكرمك", "الله يخليك", "جزاك الله خيرا", "تحت امرك",
  "مع السلامه", "سلام", "باي", "تمام", "كويس", "حلو", "ماشي", "اوك", "اوكي",
  "thanks", "thank you", "thx", "ty", "ok", "okay", "cool", "great", "bye", "goodbye",
];

/** A message that says anything about booking is a request, whatever else it says: "شكرا بس حابب
 *  أغير الميعاد" (thanks, but I'd like to change the appointment) must never be swallowed as a
 *  goodbye. */
const BOOKING_HINTS = ["احجز", "احجزلي", "حجز", "ميعاد", "موعد", "مواعيد", "كشف", "book", "booking", "appointment", "reserve", "reschedule"];

/** Past this many words a message is a sentence with something to say, not a sign-off. */
const MAX_CLOSING_WORDS = 6;

/** Lower-cased, diacritic-free, punctuation turned to spaces, padded with a space on each side so
 *  `includes(" word ")` matches whole words only. */
function paddedWords(text: string): string {
  const words = normaliseForMatch(text).replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter((w) => w !== "");
  return ` ${words.join(" ")} `;
}

function hasWord(padded: string, phrase: string): boolean {
  return padded.includes(` ${normaliseForMatch(phrase)} `);
}

/** A substring test, not whole-word: these only ever veto a sign-off, and Arabic carries its
 *  article on the word ("الميعاد", "الكشف"), which a whole-word match would miss. */
function mentionsBooking(text: string): boolean {
  const norm = normaliseForMatch(text);
  return BOOKING_HINTS.some((hint) => norm.includes(normaliseForMatch(hint)));
}

/** A message that is clearly a thank-you or a goodbye, decided locally with no model call. */
function isClosingRemark(text: string): boolean {
  // A bare emoji (👍 🙏 😊 ❤️) carries no request a booking could be started from.
  if (text.trim() !== "" && !/[\p{L}\p{N}]/u.test(text)) return true;

  const padded = paddedWords(text);
  const wordCount = padded.trim() === "" ? 0 : padded.trim().split(" ").length;
  if (wordCount === 0 || wordCount > MAX_CLOSING_WORDS) return false;
  if (mentionsBooking(text)) return false;
  return CLOSING_WORDS.some((word) => hasWord(padded, word));
}

/** The tie-breaker for a short message the word lists could not place. Only ever asked mid-session
 *  with no step in progress (right after a booking finished, say), where the choice is between
 *  starting a booking and politely signing off. Returns null if the model is down or answers
 *  something else, and the caller decides what that means. */
async function classifyFollowUp(text: string): Promise<"CLOSING" | "BOOKING" | "OTHER" | null> {
  try {
    const completion = await callGpt({
      input: [{ role: "user", content: text }],
      tools: [],
      instructions:
        "A clinic's WhatsApp assistant has just finished helping a patient. Classify the patient's next message as exactly one of: " +
        '"CLOSING" (thanks, praise, a blessing, goodbye, or any polite sign-off that asks for nothing), ' +
        '"BOOKING" (wants to book, change or ask about an appointment), or "OTHER". Egyptian Arabic is common. ' +
        "Reply with that one word and nothing else.",
    });
    const word = completion.outputText?.trim().toUpperCase();
    return word === "CLOSING" || word === "BOOKING" || word === "OTHER" ? word : null;
  } catch (error) {
    console.error("WhatsApp flow: follow-up classification call failed", error);
    return null;
  }
}

/** Should this message end the conversation politely instead of starting a booking?
 *
 *  A brand-new session is always a booking start: the patient has just arrived. Mid-session with
 *  nothing in progress, the word lists decide the clear cases and the model the rest. If the model
 *  is down, a short message with no booking word in it is treated as a sign-off: wrongly saying
 *  "at your service" costs the patient one more message, while wrongly restarting a booking in
 *  reply to "thanks" is the very thing this check exists to prevent. */
async function isClosing(ctx: FlowContext, text: string): Promise<boolean> {
  if (isClosingRemark(text)) return true;
  if (ctx.isNewSession || mentionsBooking(text)) return false;

  const verdict = await classifyFollowUp(text);
  if (verdict === "CLOSING") return true;
  if (verdict !== null) return false;
  return paddedWords(text).trim().split(" ").length <= MAX_CLOSING_WORDS;
}



/** One tappable option, reduced to what `matchByKeyword` and `classifyOrReply` need: its id, and
 *  every piece of visible text a patient might type instead of tapping it (a button/row's title,
 *  plus a list row's description when it has one). Built fresh from the step's own `FlowOutgoing`
 *  by `optionsFromOutgoing` -- never a separate hand-maintained list, so it can never drift from
 *  what the patient actually sees on screen. */
interface MatchableOption {
  id: string;
  titles: string[];
}

function optionsFromOutgoing(outgoing: FlowOutgoing): MatchableOption[] {
  if (outgoing.kind === "text") return [];
  if (outgoing.kind === "buttons") return outgoing.buttons.map((b) => ({ id: b.id, titles: [b.title] }));
  return outgoing.sections.flatMap((section) =>
    section.rows.map((row) => ({ id: row.id, titles: row.description === undefined ? [row.title] : [row.title, row.description] })),
  );
}

function normaliseForMatch(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[\u064B-\u0652]/g, "") // Arabic diacritics
    .replace(/[إأآا]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه");
}

const YES_WORDS = ["yes", "yeah", "yep", "sure", "ok", "okay", "تمام", "ايوه", "اه", "ايوة", "موافق", "حاضر"];
const NO_WORDS = ["no", "nope", "لا", "لأ", "مش موافق", "رفض"];
const ARABIC_DIGITS = "٠١٢٣٤٥٦٧٨٩";

/** Free, local, no model call -- tried before anything that costs a network round trip. Catches
 *  the common cases a fixed button-only step still deserved to handle: a typed "ايوه" instead of a
 *  tap, a bare number picking the Nth item in the list shown, or typing the option's own name (a
 *  doctor, a service) rather than tapping its row. Anything this doesn't resolve falls to
 *  `classifyOrReply` -- it never guesses when more than one option looks plausible. */
function matchByKeyword(text: string, options: MatchableOption[]): string | null {
  const norm = normaliseForMatch(text);
  if (norm.length === 0) return null;

  if (options.some((o) => o.id === "yn_yes") && YES_WORDS.some((w) => norm === normaliseForMatch(w))) return "yn_yes";
  if (options.some((o) => o.id === "yn_no") && NO_WORDS.some((w) => norm === normaliseForMatch(w))) return "yn_no";

  const westernised = norm.replace(/[٠-٩]/g, (d) => String(ARABIC_DIGITS.indexOf(d)));
  const asIndex = Number(westernised);
  if (Number.isInteger(asIndex) && asIndex >= 1 && asIndex <= options.length) {
    return options[asIndex - 1]!.id;
  }

  const substringMatches = options.filter((option) =>
    option.titles.some((title) => {
      const normTitle = normaliseForMatch(title);
      return normTitle.length > 0 && (norm.includes(normTitle) || normTitle.includes(norm));
    }),
  );
  // More than one option's title overlaps the text -- genuinely ambiguous, not this function's call
  // to break the tie. classifyOrReply (with the model actually reading the sentence) goes next.
  return substringMatches.length === 1 ? substringMatches[0]!.id : null;
}

type ClassifyOutcome = { kind: "match"; id: string } | { kind: "reply"; text: string };

/** The model's one and only job here: given the *exact finite list* of ids this specific step
 *  will accept right now, say which one (if any) the patient's free text selects -- never asked to
 *  pick from anything wider, and never trusted blindly even then. `offScriptThenRepeat` below only
 *  acts on a returned id after confirming it is one of `options`' own ids; an id the model
 *  hallucinated that isn't in that list is treated exactly like no match at all. If nothing
 *  matches, the same call doubles as the off-script answer -- one model call either way, not two. */
async function classifyOrReply(text: string, lang: Lang, options: MatchableOption[], questionBody: string): Promise<ClassifyOutcome> {
  const optionLines = options.map((o) => `${o.id}: ${o.titles.join(" / ")}`).join("\n");
  try {
    const completion = await callGpt({
      input: [{ role: "user", content: text }],
      tools: [],
      instructions:
        `A clinic's WhatsApp bot just asked: "${questionBody}". The only valid choices right now are:\n${optionLines}\n\n` +
        `If the patient's message clearly picks one of these, reply with ONLY that exact id and nothing else -- no ` +
        `punctuation, no explanation. If it does not clearly pick one, instead reply with a brief answer (2 ` +
        `sentences at most) to whatever they said, in ${lang === "ar" ? "Egyptian Arabic" : "English"}. Never invent ` +
        "clinic facts (hours, prices, availability) you were not given here. Do not mention booking, appointments, " +
        "or complaints yourself -- the app adds its own reminder after your reply.",
    });
    const raw = completion.outputText?.trim() ?? "";
    const matched = options.find((o) => o.id === raw);
    if (matched !== undefined) return { kind: "match", id: matched.id };
    return { kind: "reply", text: raw || T.pleaseUseButtons(lang) };
  } catch (error) {
    console.error("WhatsApp flow: classify-or-reply call failed", error);
    return { kind: "reply", text: T.pleaseUseButtons(lang) };
  }
}

// -------------------------------------------------------------------------------------------
// The entry point
// -------------------------------------------------------------------------------------------

export async function runFlow(ctx: FlowContext): Promise<FlowResult> {
  if (ctx.state === null) {
    if (ctx.input.kind === "interactive") {
      // A tap with no state to interpret it against -- almost always a button on a session that
      // has since gone idle and been reset. Not this file's to guess at; the caller decides what a
      // message with nothing else to go on gets.
      if (!ctx.isNewSession) return { handled: false };
      // A brand-new session that somehow opens on a tap (a forwarded message, a client replay) --
      // treat it exactly like free text would be treated: start the booking.
      return beginTurn(ctx, "ar", null);
    }
    const text = textOf(ctx.input) ?? "";
    const lang = detectLang(text);
    return beginTurn(ctx, lang, text);
  }

  switch (ctx.state.step) {
    case "PHONE_CHOICE":
      return stepPhoneChoice(ctx, ctx.state);
    case "PHONE_ASK":
      return stepPhoneAsk(ctx, ctx.state);
    case "NAME_ASK":
      return stepNameAsk(ctx, ctx.state);
    case "BOOKING_COMPLAINT":
      return stepBookingComplaint(ctx, ctx.state);
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

    // Only reachable with a state written by an older build (INTENT, COMPLAINT_TEXT,
    // COMPLAINT_CONFIRM -- the complaint route is gone from the bot -- and IDENTITY_PICK /
    // IDENTITY_YESNO, which read stored names back to the patient and no longer exist). Such a half-finished flow is
    // dropped and the patient is started on a fresh booking rather than left stuck on a step
    // nothing handles.
    default: {
      const legacyLang = (ctx.state as { lang?: Lang }).lang ?? "ar";
      return beginTurn({ ...ctx, state: null }, legacyLang, null);
    }
  }
}

/** New session or freshly finished flow, either way starting from nothing. The bot only books, so
 *  there is no menu to show: the welcome line (new sessions only) and the first booking question go
 *  out together. `openingText` is the patient's own words if this turn is free text. */
async function beginTurn(ctx: FlowContext, lang: Lang, openingText: string | null): Promise<FlowResult> {
  // A closing remark ("شكرا", "تمام", "thanks") is very often the very next message after this file
  // itself just said "تم الحجز ... لو محتاج حاجة تانية أنا موجود" (bookingSuccess), and starting a
  // brand-new booking in reply to "thanks" reads as not having listened.
  if (openingText !== null && (await isClosing(ctx, openingText))) {
    return { handled: true, nextState: null, outgoing: { kind: "text", text: T.closingAcknowledge(lang) } };
  }

  const welcomeLine = ctx.isNewSession ? `${T.welcome(lang, ctx.tenant.clinicName, dayPeriodInClinic(ctx.tenant.timezone))}\n\n` : "";
  return beginIdentity(ctx, lang, welcomeLine);
}

// -------------------------------------------------------------------------------------------
// Identity: which number is booking, then who on that number
// -------------------------------------------------------------------------------------------

function phoneChoiceOutgoing(lang: Lang, phoneE164: string, prefix: string): FlowOutgoing {
  return {
    kind: "buttons",
    body: `${prefix}${T.phoneChoiceQuestion(lang, phoneE164)}`,
    buttons: [
      { id: "yn_yes", title: T.phoneChoiceThisNumber(lang) },
      { id: "yn_no", title: T.phoneChoiceOtherNumber(lang) },
    ],
  };
}

/** Always the first question: the WhatsApp number the patient is writing from is only a guess at
 *  the number they want to book under (a relative's phone, a work phone), so it is confirmed before
 *  anything is looked up against it. */
async function beginIdentity(ctx: FlowContext, lang: Lang, prefix: string): Promise<FlowResult> {
  return {
    handled: true,
    nextState: { step: "PHONE_CHOICE", lang },
    outgoing: phoneChoiceOutgoing(lang, ctx.phoneE164, prefix),
  };
}

async function stepPhoneChoice(ctx: FlowContext, state: Extract<FlowState, { step: "PHONE_CHOICE" }>): Promise<FlowResult> {
  const id = idOf(ctx.input);
  // `phone_same` / `phone_other` are the ids an older build offered -- still honoured for a patient
  // tapping a button from a conversation that was mid-way through when this shipped.
  if (id === "yn_yes" || id === "phone_same") return askForName(state.lang, ctx.phoneE164);
  if (id === "yn_no" || id === "phone_other") {
    return {
      handled: true,
      nextState: { step: "PHONE_ASK", lang: state.lang },
      outgoing: { kind: "text", text: T.phoneAskQuestion(state.lang) },
    };
  }
  return offScriptThenRepeat(ctx, state.lang, phoneChoiceOutgoing(state.lang, ctx.phoneE164, ""));
}

async function stepPhoneAsk(ctx: FlowContext, state: Extract<FlowState, { step: "PHONE_ASK" }>): Promise<FlowResult> {
  const text = textOf(ctx.input);
  const normalised = text === null ? null : normalisePhone(text, EGYPT);
  if (normalised === null) {
    return { handled: true, nextState: state, outgoing: { kind: "text", text: T.phoneInvalid(state.lang) } };
  }
  // A different number the patient names is their contact phone only -- the WhatsApp sender stays
  // the conversation's own contact (whatsapp-conversation.ts's Contact row is never touched here).
  return askForName(state.lang, normalised);
}

/** The number to book under is settled. Nothing stored about that number is read back to the patient --
 *  a number can be dropped and resold, and its next owner must not learn a stranger's name. They are
 *  asked for their own full name instead, and `stepNameAsk` matches it quietly against the names on file. */
function askForName(lang: Lang, phoneE164: string): FlowResult {
  return {
    handled: true,
    nextState: { step: "NAME_ASK", lang, phoneE164 },
    outgoing: { kind: "text", text: T.nameAskQuestion(lang) },
  };
}

/** Two words at least ("أحمد محمد"): one first name alone is too easy to guess and too weak to match on. */
const MIN_NAME_WORDS = 2;
const MAX_NAME_CHARS = 120;

async function stepNameAsk(ctx: FlowContext, state: Extract<FlowState, { step: "NAME_ASK" }>): Promise<FlowResult> {
  const text = textOf(ctx.input)?.trim().replace(/\s+/g, " ");
  const words = text === undefined || text === "" ? [] : text.split(" ");
  if (text === undefined || words.length < MIN_NAME_WORDS || !/\p{L}/u.test(text) || text.length > MAX_NAME_CHARS) {
    return { handled: true, nextState: state, outgoing: { kind: "text", text: T.nameInvalid(state.lang) } };
  }

  // Is this one of the people already registered on the number? Never answered by showing a stored name:
  // the patient sees only the name they typed themselves (patient-name-match.ts has the two tiers).
  const existing = await ctx.client.findPatientsByPhone(state.phoneE164);
  if (!existing.ok) return errorResult(state.lang, "");
  const onFile = existing.value.patients.map((p) => ({ patientId: p.patientId, displayName: p.displayName }));

  const found = matchByName(text, onFile);
  const matched =
    found.kind === "match" ? found.patient : found.kind === "candidates" ? await pickByModel(text, found.candidates) : null;
  if (matched !== null) return afterIdentity(state.lang, { patientId: matched.patientId, patientName: text });

  // Nobody on this number goes by that name: a new patient, never a rename of anyone's record.
  const created = await ctx.client.createProvisionalPatient({ fullNameAr: text, phoneE164: state.phoneE164 });
  if (!created.ok) return errorResult(state.lang, "");
  return afterIdentity(state.lang, { patientId: created.value.patientId, patientName: text });
}

/** Identity resolved -- the medical complaint is the next thing a booking needs, before the doctor. */
function afterIdentity(lang: Lang, person: Person): FlowResult {
  return {
    handled: true,
    nextState: { step: "BOOKING_COMPLAINT", lang, ...person },
    outgoing: { kind: "text", text: T.bookingComplaintAsk(lang) },
  };
}

/** The complaint is required -- it is the reason for the visit, and it lands in the consultation's
 *  complaint field for the doctor to see (and edit). Free text, so no keyword or model matching:
 *  whatever the patient writes here, if it has substance, is the answer. */
async function stepBookingComplaint(ctx: FlowContext, state: Extract<FlowState, { step: "BOOKING_COMPLAINT" }>): Promise<FlowResult> {
  const text = textOf(ctx.input)?.trim();
  if (text === undefined) {
    // A stale button tap -- nothing to read, so the question is simply asked again.
    return { handled: true, nextState: state, outgoing: { kind: "text", text: T.bookingComplaintAsk(state.lang) } };
  }
  if (text.length < MIN_COMPLAINT_CHARS) {
    return { handled: true, nextState: state, outgoing: { kind: "text", text: T.bookingComplaintTooShort(state.lang) } };
  }
  return beginBookingDoctor(ctx, state.lang, {
    patientId: state.patientId,
    patientName: state.patientName,
    complaint: text.slice(0, MAX_COMPLAINT_CHARS),
  });
}

// -------------------------------------------------------------------------------------------
// Booking
// -------------------------------------------------------------------------------------------

/** What every booking step after the complaint carries, so each one can build the next step's state
 *  without re-listing the patient's fields (a field forgotten in one of them is a silent drop). */
type BookingBase = { lang: Lang; doctorId: string; doctorName: string; serviceId: string; serviceName: string } & Person;

function personOf(state: Person): Person {
  return {
    patientId: state.patientId,
    patientName: state.patientName,
    ...(state.complaint === undefined ? {} : { complaint: state.complaint }),
    ...(state.reschedule === undefined ? {} : { reschedule: state.reschedule }),
  };
}

function bookingBaseOf(state: BookingBase): BookingBase {
  return {
    lang: state.lang,
    doctorId: state.doctorId,
    doctorName: state.doctorName,
    serviceId: state.serviceId,
    serviceName: state.serviceName,
    ...personOf(state),
  };
}

function doctorListOutgoing(lang: Lang, doctors: { id: string; fullName: string; specialty: string }[]): FlowOutgoing {
  const rows = doctors.map((d) => ({ id: `doc_${d.id}`, title: d.fullName.slice(0, 24), description: d.specialty.slice(0, 72) }));
  return { kind: "list", body: T.bookingDoctorQuestion(lang), buttonLabel: T.bookingListOpen(lang), sections: [{ title: T.bookingDoctorQuestion(lang).slice(0, 24), rows }] };
}

async function beginBookingDoctor(ctx: FlowContext, lang: Lang, person: Person): Promise<FlowResult> {
  const doctors = await ctx.client.listDoctors();
  if (!doctors.ok) return errorResult(lang, "");
  if (doctors.value.doctors.length === 0) return errorResult(lang, "");

  if (doctors.value.doctors.length === 1) {
    const only = doctors.value.doctors[0]!;
    return beginBookingService(ctx, lang, person, { id: only.id, name: only.fullName });
  }

  return {
    handled: true,
    nextState: { step: "BOOKING_DOCTOR", lang, ...person },
    outgoing: doctorListOutgoing(lang, doctors.value.doctors),
  };
}

async function stepBookingDoctor(ctx: FlowContext, state: Extract<FlowState, { step: "BOOKING_DOCTOR" }>): Promise<FlowResult> {
  const id = idOf(ctx.input);
  const doctors = await ctx.client.listDoctors();
  if (id?.startsWith("doc_")) {
    if (!doctors.ok) return errorResult(state.lang, "");
    const picked = doctors.value.doctors.find((d) => d.id === id.slice(4));
    if (picked !== undefined) {
      return beginBookingService(ctx, state.lang, personOf(state), { id: picked.id, name: picked.fullName });
    }
  }
  return offScriptThenRepeat(ctx, state.lang, doctorListOutgoing(state.lang, doctors.ok ? doctors.value.doctors : []));
}

function serviceListOutgoing(lang: Lang, services: { id: string; nameAr: string; nameEn: string }[]): FlowOutgoing {
  const rows = services.map((s) => ({ id: `svc_${s.id}`, title: (lang === "ar" ? s.nameAr : s.nameEn).slice(0, 24) }));
  return { kind: "list", body: T.bookingServiceQuestion(lang), buttonLabel: T.bookingListOpen(lang), sections: [{ title: T.bookingServiceQuestion(lang).slice(0, 24), rows }] };
}

async function beginBookingService(ctx: FlowContext, lang: Lang, person: Person, doctor: { id: string; name: string }): Promise<FlowResult> {
  const services = await ctx.client.listServices();
  if (!services.ok) return errorResult(lang, "");
  if (services.value.services.length === 0) return errorResult(lang, "");

  if (services.value.services.length === 1) {
    const only = services.value.services[0]!;
    return beginBookingDate(ctx, lang, person, doctor, { id: only.id, name: lang === "ar" ? only.nameAr : only.nameEn });
  }

  return {
    handled: true,
    nextState: { step: "BOOKING_SERVICE", lang, doctorId: doctor.id, doctorName: doctor.name, ...person },
    outgoing: serviceListOutgoing(lang, services.value.services),
  };
}

async function stepBookingService(ctx: FlowContext, state: Extract<FlowState, { step: "BOOKING_SERVICE" }>): Promise<FlowResult> {
  const id = idOf(ctx.input);
  const doctor = { id: state.doctorId, name: state.doctorName };
  const services = await ctx.client.listServices();
  if (id?.startsWith("svc_")) {
    if (!services.ok) return errorResult(state.lang, "");
    const picked = services.value.services.find((s) => s.id === id.slice(4));
    if (picked !== undefined) {
      return beginBookingDate(ctx, state.lang, personOf(state), doctor, { id: picked.id, name: state.lang === "ar" ? picked.nameAr : picked.nameEn });
    }
  }
  return offScriptThenRepeat(ctx, state.lang, serviceListOutgoing(state.lang, services.ok ? services.value.services : []));
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
    const noDates = person.reschedule === undefined ? T.bookingNoDatesAhead(lang) : T.rescheduleNoDates(lang);
    return { handled: true, nextState: null, outgoing: { kind: "text", text: noDates } };
  }

  return {
    handled: true,
    nextState: { step: "BOOKING_DATE", lang, doctorId: doctor.id, doctorName: doctor.name, serviceId: service.id, serviceName: service.name, ...person },
    outgoing: dateListOutgoing(lang, dates),
  };
}

function dateListOutgoing(lang: Lang, dates: string[]): FlowOutgoing {
  const rows = dates.map((iso) => ({ id: `date_${iso}`, title: dateRowLabel(iso, lang) }));
  rows.push({ id: "date_other", title: T.bookingDateOther(lang) });
  return { kind: "list", body: T.bookingDateQuestion(lang), buttonLabel: T.bookingListOpen(lang), sections: [{ title: T.bookingDateQuestion(lang).slice(0, 24), rows }] };
}

/** A slot the patient can still take: it starts after `now`. The API's own list is not trusted to
 *  have dropped slots earlier today (it answers for a whole calendar day), so every list built here
 *  -- the day's slots, and the check that a day is worth offering at all -- applies this one rule. */
function isFutureSlot(slot: { start: string }, now: Date): boolean {
  return new Date(slot.start) > now;
}

/** Probes forward day by day (sequential, not parallel -- a chat reply has no reason to fire twenty
 *  concurrent requests at the slot engine) until `DATES_WANTED` open days are found or the horizon
 *  runs out. A day with nothing bookable *from this moment on* never makes the list -- today
 *  included: once the last slot of the day has started, today is not offered. */
async function findUpcomingDates(client: BotApiClient, doctorId: string, serviceId: string, timezone: string): Promise<string[]> {
  const dates: string[] = [];
  const today = todayInClinic(timezone);
  const now = new Date();
  for (let offset = 0; offset < DATE_SEARCH_HORIZON_DAYS && dates.length < DATES_WANTED; offset++) {
    const date = offset === 0 ? today : addDaysIso(today, offset);
    const result = await client.listSlots({ doctorId, serviceId, date });
    if (result.ok && result.value.slots.some((slot) => isFutureSlot(slot, now))) dates.push(date);
  }
  return dates;
}

/** Reads a typed date with the model, which understands what a keyword list cannot ("الخميس الجاي",
 *  "بعد بكرة", "next Sunday", "12 أكتوبر"), and is told today's date so relative words resolve
 *  against the clinic's calendar. The answer is never trusted as given: it must be a real calendar
 *  date in `YYYY-MM-DD` shape or it is treated as no answer at all. */
async function parseDateWithModel(text: string, timezone: string): Promise<string | null> {
  const today = todayInClinic(timezone);
  try {
    const completion = await callGpt({
      input: [{ role: "user", content: text }],
      tools: [],
      instructions:
        `A clinic's WhatsApp bot asked a patient which day they want an appointment. Today is ${today} (${weekdayName(today)}) in Egypt. ` +
        "Convert the patient's message to exactly one calendar date. Rules: dates are day-first (Egyptian convention), so 5-10 means 5 October; " +
        '"بكرة"/"tomorrow" is tomorrow and "بعد بكرة" is the day after tomorrow; a weekday name ("الخميس", "next Sunday", "الأحد الجاي") ' +
        "means the next such weekday after today; a date with no year means its next upcoming occurrence; Arabic-Indic digits are digits. " +
        "Reply with ONLY the date as YYYY-MM-DD. If the message is not a date, or cannot be pinned to a single day, reply with exactly NONE.",
    });
    const raw = completion.outputText?.trim() ?? "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
    const asDate = new Date(`${raw}T00:00:00Z`);
    if (Number.isNaN(asDate.getTime()) || asDate.toISOString().slice(0, 10) !== raw) return null;
    return raw;
  } catch (error) {
    console.error("WhatsApp flow: date parsing call failed", error);
    return null;
  }
}

/** Typed free text -> a date. The model first; the local parser (`parseFlowDate`) only as the net
 *  under it, for the moment the model call fails or declines, so a plain "12-10-2026" still works
 *  with the model down. */
async function resolveTypedDate(text: string, timezone: string): Promise<string | null> {
  return (await parseDateWithModel(text, timezone)) ?? parseFlowDate(text, timezone);
}

/** A bare one- or two-digit number typed under a numbered list means "that row", not "the 5th of the
 *  month" -- `offScriptThenRepeat`'s keyword matcher resolves it, so it is never sent to the model. */
function isListIndexReply(text: string): boolean {
  return /^[0-9٠-٩]{1,2}$/.test(text.trim());
}

async function stepBookingDate(ctx: FlowContext, state: Extract<FlowState, { step: "BOOKING_DATE" }>): Promise<FlowResult> {
  const id = idOf(ctx.input);
  if (id === "date_other") {
    return {
      handled: true,
      nextState: { step: "BOOKING_DATE_FREE", ...bookingBaseOf(state) },
      outgoing: { kind: "text", text: T.bookingDateFreeAsk(state.lang) },
    };
  }
  if (id?.startsWith("date_")) {
    return listSlotsForDate(ctx, state, id.slice(5));
  }

  // Anything typed instead of picking a row goes to the model to be read as a date.
  const text = textOf(ctx.input);
  if (text !== null && !isListIndexReply(text)) {
    const parsed = await resolveTypedDate(text, ctx.tenant.timezone);
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
  const parsed = text === null ? null : await resolveTypedDate(text, ctx.tenant.timezone);
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
async function bookingDateOutgoing(ctx: FlowContext, state: BookingBase): Promise<FlowOutgoing> {
  const dates = await findUpcomingDates(ctx.client, state.doctorId, state.serviceId, ctx.tenant.timezone);
  return dateListOutgoing(state.lang, dates);
}

async function listSlotsForDate(ctx: FlowContext, state: BookingBase, date: string): Promise<FlowResult> {
  const result = await ctx.client.listSlots({ doctorId: state.doctorId, serviceId: state.serviceId, date });
  if (!result.ok) return errorResult(state.lang, "");

  const now = new Date();
  const slots = result.value.slots
    .filter((slot) => isFutureSlot(slot, now))
    .map((slot) => ({ iso: slot.start, token: slot.token, label: timeOnly(formatInClinicTime(new Date(slot.start), ctx.tenant.timezone)) }));

  if (slots.length === 0) {
    // Nothing left that day: say so and put the date list back in front of the patient, rather than
    // leaving them to guess what to type.
    const dateState: Extract<FlowState, { step: "BOOKING_DATE" }> = { step: "BOOKING_DATE", ...bookingBaseOf(state) };
    const outgoing = await bookingDateOutgoing(ctx, dateState);
    return {
      handled: true,
      nextState: dateState,
      outgoing: prependText(outgoing, T.bookingNoSlotsOnDate(state.lang)) ?? outgoing,
    };
  }

  return sendSlotPage(state, date, slots, 0);
}

function slotListOutgoing(state: BookingBase, date: string, slots: { iso: string; token: string; label: string }[], page: number): FlowOutgoing {
  const { pageItems, hasMore } = pageSlots(slots, page);
  const rows = pageItems.map((slot, index) => ({ id: slotRowId(index), title: slot.label }));
  if (hasMore) rows.push({ id: "more", title: T.bookingSlotMore(state.lang) });
  return { kind: "list", body: T.bookingSlotQuestion(state.lang), buttonLabel: T.bookingListOpen(state.lang), sections: [{ title: dateRowLabel(date, state.lang), rows }] };
}

function sendSlotPage(state: BookingBase, date: string, slots: { iso: string; token: string; label: string }[], page: number): FlowResult {
  return {
    handled: true,
    nextState: { step: "BOOKING_SLOT", ...bookingBaseOf(state), date, slots, page },
    outgoing: slotListOutgoing(state, date, slots, page),
  };
}

function confirmOutgoing(state: Extract<FlowState, { step: "BOOKING_CONFIRM" }>, slotLabel: string): FlowOutgoing {
  const dateLabel = dateRowLabel(state.date, state.lang);
  if (state.reschedule !== undefined) {
    return {
      kind: "buttons",
      body: T.rescheduleConfirmQuestion(state.lang, state.doctorName, state.serviceName, state.reschedule.fromLabel, dateLabel, slotLabel, state.priceLabel),
      buttons: [
        { id: "yn_yes", title: T.rescheduleConfirmButton(state.lang) },
        { id: "yn_no", title: T.bookingChangeButton(state.lang) },
      ],
    };
  }
  return {
    kind: "buttons",
    body: T.bookingConfirmQuestion(state.lang, state.doctorName, state.serviceName, dateLabel, slotLabel, state.patientName, state.complaint, state.priceLabel),
    buttons: [
      { id: "yn_yes", title: T.bookingConfirmButton(state.lang) },
      { id: "yn_no", title: T.bookingChangeButton(state.lang) },
    ],
  };
}

/** The price of the service the patient picked, as a message line ("300 جنيه"). Read from the service list
 *  at the moment the confirm screen is built; `undefined` when the clinic has not priced it, or the list
 *  could not be read -- a missing price never blocks a booking. */
async function priceLabelFor(client: BotApiClient, serviceId: string, lang: Lang): Promise<string | undefined> {
  const services = await client.listServices();
  if (!services.ok) return undefined;
  const service = services.value.services.find((candidate) => candidate.id === serviceId);
  if (service === undefined) return undefined;
  return formatPrice(service.priceMinor, service.currency, lang) ?? undefined;
}

async function stepBookingSlot(ctx: FlowContext, state: Extract<FlowState, { step: "BOOKING_SLOT" }>): Promise<FlowResult> {
  const id = idOf(ctx.input);
  if (id === "more") {
    return sendSlotPage(state, state.date, state.slots, state.page + 1);
  }
  if (id !== null && /^s[1-9]$/.test(id)) {
    const indexOnPage = Number(id.slice(1)) - 1;
    const { pageItems } = pageSlots(state.slots, state.page);
    const picked = pageItems[indexOnPage];
    if (picked !== undefined) {
      const priceLabel = await priceLabelFor(ctx.client, state.serviceId, state.lang);
      const nextState: Extract<FlowState, { step: "BOOKING_CONFIRM" }> = {
        step: "BOOKING_CONFIRM",
        ...bookingBaseOf(state),
        date: state.date,
        slotIso: picked.iso,
        slotLabel: picked.label,
        token: picked.token,
        ...(priceLabel === undefined ? {} : { priceLabel }),
      };
      return { handled: true, nextState, outgoing: confirmOutgoing(nextState, picked.label) };
    }
  }
  return offScriptThenRepeat(ctx, state.lang, slotListOutgoing(state, state.date, state.slots, state.page));
}

async function stepBookingConfirm(ctx: FlowContext, state: Extract<FlowState, { step: "BOOKING_CONFIRM" }>): Promise<FlowResult> {
  const id = idOf(ctx.input);
  if (id === "yn_no") {
    // Editing an appointment keeps its doctor and service: only the day and time are chosen again.
    if (state.reschedule !== undefined) {
      return beginBookingDate(ctx, state.lang, personOf(state), { id: state.doctorId, name: state.doctorName }, { id: state.serviceId, name: state.serviceName });
    }
    // "Change" starts the choices over but keeps who is booking and why -- neither is re-asked.
    return beginBookingDoctor(ctx, state.lang, personOf(state));
  }
  if (id === "yn_yes") {
    return state.reschedule === undefined ? confirmBooking(ctx, state) : rescheduleBooking(ctx, state, state.reschedule);
  }
  return offScriptThenRepeat(ctx, state.lang, confirmOutgoing(state, state.slotLabel));
}

async function confirmBooking(ctx: FlowContext, state: Extract<FlowState, { step: "BOOKING_CONFIRM" }>): Promise<FlowResult> {
  const complaintSummary = state.complaint === undefined ? {} : { complaintSummary: state.complaint };
  let result = await ctx.client.bookAppointment({ patientId: state.patientId, slotToken: state.token, consentMessageId: ctx.inboundExternalMessageId, ...complaintSummary });

  // The token was minted when the list was shown; if the patient took a while, retry once against
  // a freshly re-listed offer for the same date and time -- never against a token the model or the
  // patient supplied, only ever against what the API itself just re-confirmed is bookable.
  if (!result.ok && (result.code === "INVALID_TOKEN" || result.code === "EXPIRED_TOKEN")) {
    const refreshed = await ctx.client.listSlots({ doctorId: state.doctorId, serviceId: state.serviceId, date: state.date });
    const match = refreshed.ok ? refreshed.value.slots.find((slot) => slot.start === state.slotIso) : undefined;
    if (match !== undefined) {
      result = await ctx.client.bookAppointment({ patientId: state.patientId, slotToken: match.token, consentMessageId: ctx.inboundExternalMessageId, ...complaintSummary });
    }
  }

  if (!result.ok) {
    if (result.code === "SLOT_TAKEN" || result.code === "INVALID_TOKEN" || result.code === "EXPIRED_TOKEN") {
      return offerSlotsAgain(ctx, state);
    }
    return errorResult(state.lang, "");
  }

  return {
    handled: true,
    nextState: null,
    outgoing: { kind: "text", text: T.bookingSuccess(state.lang, state.doctorName, dateRowLabel(state.date, state.lang), state.slotLabel, state.priceLabel) },
  };
}

/** The slot was taken (or its token went stale): the same day's list again, with the apology on top. */
async function offerSlotsAgain(ctx: FlowContext, state: Extract<FlowState, { step: "BOOKING_CONFIRM" }>): Promise<FlowResult> {
  const slotResult = await listSlotsForDate(ctx, state, state.date);
  return {
    ...slotResult,
    outgoing: slotResult.outgoing?.kind === "text" ? slotResult.outgoing : prependText(slotResult.outgoing, T.bookingSlotTaken(state.lang)),
  };
}

/**
 * Editing an existing appointment: the last step of the same date -> time -> confirm steps a booking uses,
 * but it moves the appointment the reminder was about instead of creating a second one. The move is one
 * atomic update on the server, so the patient never loses the old time before holding the new one.
 *
 * Checked again here, not trusted from the tap: the appointment may have been cancelled, moved by the
 * desk, or already edited twice since the screen was shown.
 */
async function rescheduleBooking(
  ctx: FlowContext,
  state: Extract<FlowState, { step: "BOOKING_CONFIRM" }>,
  target: RescheduleTarget,
): Promise<FlowResult> {
  const lang = state.lang;
  const unavailable: FlowResult = { handled: true, nextState: null, outgoing: { kind: "text", text: T.rescheduleUnavailable(lang) } };

  const status = await ctx.client.readAppointmentStatus(target.appointmentId);
  if (!status.ok) return status.status === 404 ? unavailable : errorResult(lang, "");
  const live = status.value.status === "BOOKED" || status.value.status === "CONFIRMED";
  const unchanged = new Date(status.value.scheduledStart).getTime() === new Date(target.originalStart).getTime();
  if (!live || !unchanged) return unavailable;
  if (status.value.rescheduleCount >= MAX_PATIENT_RESCHEDULES) {
    return { handled: true, nextState: null, outgoing: { kind: "text", text: T.rescheduleLimit(lang) } };
  }

  let result = await ctx.client.rescheduleAppointment(target.appointmentId, state.token);
  // Same token refresh a booking gets: re-list the day, and retry only against what the API just offered.
  if (!result.ok && (result.code === "INVALID_TOKEN" || result.code === "EXPIRED_TOKEN")) {
    const refreshed = await ctx.client.listSlots({ doctorId: state.doctorId, serviceId: state.serviceId, date: state.date });
    const match = refreshed.ok ? refreshed.value.slots.find((slot) => slot.start === state.slotIso) : undefined;
    if (match !== undefined) result = await ctx.client.rescheduleAppointment(target.appointmentId, match.token);
  }

  if (!result.ok) {
    if (["SLOT_TAKEN", "INVALID_TOKEN", "EXPIRED_TOKEN", "PAST_SLOT", "CONTENDED"].includes(result.code)) {
      return offerSlotsAgain(ctx, state);
    }
    if (result.code === "ILLEGAL_TRANSITION" || result.code === "NOT_FOUND") return unavailable;
    return errorResult(lang, "");
  }

  return {
    handled: true,
    nextState: null,
    outgoing: { kind: "text", text: T.rescheduleSuccess(lang, state.doctorName, dateRowLabel(state.date, lang), state.slotLabel, state.priceLabel) },
  };
}

export interface RescheduleStart {
  tenant: WhatsAppTenant;
  client: BotApiClient;
  appointmentId: string;
  originalStart: Date;
  patient: { id: string; name: string };
  doctor: { id: string; name: string };
  service: { id: string; name: string };
}

/**
 * Entry point for the reminder's "تعديل الموعد" button (reminder-reply.ts, which has already verified the
 * sender owns the appointment and that it is still editable). Starts the booking steps at the date list,
 * keeping the appointment's own doctor and service; a different doctor means cancelling and rebooking.
 * The reminder itself is left untouched, so its confirm deadline keeps running as the clinic set it.
 */
export async function startReschedule(input: RescheduleStart): Promise<FlowResult> {
  const lang: Lang = "ar";
  const [fromDate = "", fromTime = ""] = formatInClinicTime(input.originalStart, input.tenant.timezone).split(" ");
  const reschedule: RescheduleTarget = {
    appointmentId: input.appointmentId,
    originalStart: input.originalStart.toISOString(),
    fromLabel: `${dateRowLabel(fromDate, lang)} ${fromTime}`.trim(),
  };
  const person: Person = { patientId: input.patient.id, patientName: input.patient.name, reschedule };

  const dates = await findUpcomingDates(input.client, input.doctor.id, input.service.id, input.tenant.timezone);
  if (dates.length === 0) {
    return { handled: true, nextState: null, outgoing: { kind: "text", text: T.rescheduleNoDates(lang) } };
  }
  const list = dateListOutgoing(lang, dates);
  return {
    handled: true,
    nextState: {
      step: "BOOKING_DATE",
      lang,
      doctorId: input.doctor.id,
      doctorName: input.doctor.name,
      serviceId: input.service.id,
      serviceName: input.service.name,
      ...person,
    },
    outgoing: prependText(list, T.rescheduleIntro(lang)) ?? list,
  };
}

function prependText(outgoing: FlowOutgoing | undefined, line: string): FlowOutgoing | undefined {
  if (outgoing === undefined) return outgoing;
  if (outgoing.kind === "text") return { kind: "text", text: `${line}\n\n${outgoing.text}` };
  return { ...outgoing, body: `${line}\n\n${outgoing.body}` };
}

// -------------------------------------------------------------------------------------------
// Shared
// -------------------------------------------------------------------------------------------

/**
 * Free text (or an unrecognised tap id) arrived at a step that expects one of `repeat`'s own
 * options. Three stages, cheapest first:
 *
 * 1. `matchByKeyword` -- local, free, no model call.
 * 2. `classifyOrReply` -- one model call, closed-set: a real id, or a fallback answer.
 * 3. Neither resolves it -- the same question is repeated with that answer folded in, and a miss is
 *    counted. After `MAX_UNMATCHED_ATTEMPTS` straight misses *at this step*, the flow gives up
 *    rather than loop the patient forever, and hands them to the clinic directly.
 *
 * A resolved id (stage 1 or 2) is never acted on here -- it is handed back into `runFlow` as though
 * it had been tapped, so the one real implementation of "what doc_<id> means" stays in the step
 * handler that already has it, never duplicated.
 */
async function offScriptThenRepeat(ctx: FlowContext, lang: Lang, repeat: FlowOutgoing): Promise<FlowResult> {
  const text = textOf(ctx.input);
  const state = ctx.state as FlowState; // present on every call site -- only reached from within a step handler.
  if (text === null) {
    return { handled: true, nextState: state, outgoing: repeat };
  }

  const options = optionsFromOutgoing(repeat);

  const keywordMatch = matchByKeyword(text, options);
  if (keywordMatch !== null) {
    return runFlow({ ...ctx, input: { kind: "interactive", id: keywordMatch }, state });
  }

  const questionBody = repeat.kind === "text" ? repeat.text : repeat.body;
  const classified: ClassifyOutcome =
    options.length === 0 ? { kind: "reply", text: T.pleaseUseButtons(lang) } : await classifyOrReply(text, lang, options, questionBody);

  if (classified.kind === "match") {
    return runFlow({ ...ctx, input: { kind: "interactive", id: classified.id }, state });
  }

  const missCount = (state.missCount ?? 0) + 1;
  if (missCount >= MAX_UNMATCHED_ATTEMPTS) {
    return { handled: true, nextState: null, outgoing: { kind: "text", text: T.escapeHatch(lang) } };
  }

  const nudge = repeat.kind === "text" ? `${classified.text}\n\n${T.pleaseUseButtons(lang)}` : classified.text;
  return { handled: true, nextState: { ...state, missCount }, outgoing: prependText(repeat, nudge) ?? repeat };
}

function errorResult(lang: Lang, prefix: string): FlowResult {
  return { handled: true, nextState: null, outgoing: { kind: "text", text: `${prefix}${T.genericError(lang)}` } };
}
