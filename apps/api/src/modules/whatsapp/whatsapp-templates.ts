// The WhatsApp message templates the platform sends on its own initiative, and the one place their
// wording lives.
//
// A template is the only way to message a patient outside Meta's 24-hour customer-service window, and
// the three things sent here -- a reminder, a cancellation notice, a documents link -- go to people who
// have not written recently. Templates belong to a clinic's WhatsApp Business Account, so the text below
// is what `scripts/whatsapp-templates.ts` submits to each clinic's WABA for review, and the same
// definitions build the send. One source for both is what stops an approved template and the
// parameters we send it from drifting apart.
//
// All of them are UTILITY: each is about something the patient already booked or attended. Meta's
// review is stricter about promotional wording, and nothing here is promotional.
//
// Arabic only, for now. The clinic's patients are Arabic speakers and the platform's own letterhead is
// the only English text it prints (PHASE-4.md Q45); a second language is a second set of approvals
// per clinic, which is a cost that should be chosen rather than defaulted into.

import type { WhatsAppTemplateSend } from "./whatsapp-graph-client.ts";

export const TEMPLATE_LANGUAGE = "ar";

export type TemplateKey =
  | "reminderWithDeadline"
  | "reminderPlain"
  | "autoCancelled"
  | "callIn"
  | "visitDocuments";

interface TemplateDefinition {
  name: string;
  body: string;
  /** One example per `{{n}}`, which Meta requires to review a template. */
  examples: string[];
  /** Quick-reply button labels (max 20 characters each), in order. */
  quickReplies?: string[];
  /** A URL button: its label, and the address the dynamic part is appended to. */
  urlButton?: { label: string };
}

export const TEMPLATES: Record<TemplateKey, TemplateDefinition> = {
  // {{1}} first name, {{2}} clinic, {{3}} doctor, {{4}} date and time, {{5}} the confirm-by time.
  reminderWithDeadline: {
    name: "appointment_reminder_confirm",
    body:
      "مرحباً {{1}}، نذكّرك بموعدك في {{2}} مع {{3}} يوم {{4}}.\n" +
      "يرجى تأكيد حضورك قبل الساعة {{5}}، وإلا سيتم إلغاء الموعد تلقائياً لإتاحته لمريض آخر.",
    examples: ["أحمد", "عيادة النور", "د. محمد علي", "الأحد 18 أكتوبر الساعة 10:30 ص", "8:30 ص"],
    quickReplies: ["تأكيد الحضور", "إلغاء الموعد"],
  },
  // The same reminder for an appointment that will not be cancelled if nobody answers.
  reminderPlain: {
    name: "appointment_reminder",
    body:
      "مرحباً {{1}}، نذكّرك بموعدك في {{2}} مع {{3}} يوم {{4}}.\n" +
      "يرجى تأكيد حضورك أو إلغاء الموعد إن لم تتمكن من الحضور.",
    examples: ["أحمد", "عيادة النور", "د. محمد علي", "الأحد 18 أكتوبر الساعة 10:30 ص"],
    quickReplies: ["تأكيد الحضور", "إلغاء الموعد"],
  },
  // {{1}} first name, {{2}} clinic, {{3}} doctor, {{4}} date and time.
  autoCancelled: {
    name: "appointment_auto_cancelled",
    body:
      "مرحباً {{1}}، تم إلغاء موعدك في {{2}} مع {{3}} يوم {{4}} لأننا لم نتلقَّ تأكيداً لحضورك.\n" +
      "يمكنك حجز موعد جديد في أي وقت بإرسال رسالة هنا.",
    examples: ["أحمد", "عيادة النور", "د. محمد علي", "الأحد 18 أكتوبر الساعة 10:30 ص"],
  },
  // {{1}} first name, {{2}} where to go: the room, or the doctor when the room is not recorded.
  // Meta rejects a body that starts or ends with a variable, and reclassifies friendly filler as
  // MARKETING, so the closing words state what happens next instead of wishing the patient well.
  callIn: {
    name: "patient_call_in_v2",
    body: "مرحباً {{1}}، حان دورك الآن. تفضّل بالدخول إلى {{2}} لبدء الكشف.",
    examples: ["أحمد", "غرفة 2 - د. محمد علي"],
  },
  // {{1}} first name, {{2}} clinic, {{3}} how many days the link stays valid.
  visitDocuments: {
    name: "visit_documents",
    body:
      "مرحباً {{1}}، شكراً لزيارتك {{2}}.\n" +
      "تجد في الرابط أدناه التقارير والفاتورة الخاصة بزيارتك ويمكنك تحميلها. الرابط صالح لمدة {{3}} يوماً.",
    examples: ["أحمد", "عيادة النور", "30"],
    urlButton: { label: "عرض المستندات" },
  },
};

/** The payload prefix on a reminder's buttons. `rem:c:<intentId>` confirms, `rem:x:<intentId>` cancels. */
export const REMINDER_PAYLOAD_PREFIX = "rem:";

export function reminderPayloads(intentId: string): [string, string] {
  return [`${REMINDER_PAYLOAD_PREFIX}c:${intentId}`, `${REMINDER_PAYLOAD_PREFIX}x:${intentId}`];
}

export interface ParsedReminderPayload {
  action: "confirm" | "cancel";
  intentId: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `null` for anything that is not exactly what `reminderPayloads` produced. */
export function parseReminderPayload(payload: string | undefined): ParsedReminderPayload | null {
  if (payload === undefined || !payload.startsWith(REMINDER_PAYLOAD_PREFIX)) return null;
  const [, action, intentId] = payload.split(":");
  if ((action !== "c" && action !== "x") || intentId === undefined || !UUID.test(intentId)) return null;
  return { action: action === "c" ? "confirm" : "cancel", intentId };
}

/**
 * Meta refuses a parameter containing a newline, a tab, or more than four spaces in a row. A patient's
 * or a doctor's name is typed by a person, so this runs on every parameter instead of trusting it.
 */
export function cleanParam(value: string): string {
  const cleaned = value.replace(/[\r\n\t]+/g, " ").replace(/ {2,}/g, " ").trim();
  return cleaned === "" ? "-" : cleaned.slice(0, 120);
}

export function buildTemplateSend(
  key: TemplateKey,
  input: { params: string[]; quickReplyPayloads?: string[]; urlButtonSuffix?: string },
): WhatsAppTemplateSend {
  const definition = TEMPLATES[key];
  const expected = definition.examples.length;
  if (input.params.length !== expected) {
    throw new Error(`Template ${definition.name} takes ${expected} parameters, got ${input.params.length}.`);
  }
  const buttonIndex = definition.quickReplies?.length ?? 0;
  return {
    name: definition.name,
    language: TEMPLATE_LANGUAGE,
    bodyParams: input.params.map(cleanParam),
    ...(input.quickReplyPayloads === undefined ? {} : { quickReplyPayloads: input.quickReplyPayloads }),
    ...(input.urlButtonSuffix === undefined ? {} : { urlButtonSuffix: input.urlButtonSuffix, urlButtonIndex: buttonIndex }),
  };
}

/** Meta's submission shape for one template. `appUrl` is the public web address the documents button opens. */
export function templateSubmission(
  key: TemplateKey,
  appUrl: string,
): { name: string; language: string; category: "UTILITY"; components: unknown[] } {
  const definition = TEMPLATES[key];
  const components: unknown[] = [
    { type: "BODY", text: definition.body, example: { body_text: [definition.examples] } },
  ];

  const buttons: unknown[] = [];
  for (const label of definition.quickReplies ?? []) {
    if (label.length > 20) throw new Error(`Template ${definition.name}: button label over 20 characters: ${label}`);
    buttons.push({ type: "QUICK_REPLY", text: label });
  }
  if (definition.urlButton !== undefined) {
    const base = appUrl.replace(/\/+$/, "");
    buttons.push({
      type: "URL",
      text: definition.urlButton.label,
      url: `${base}/d/{{1}}`,
      example: [`${base}/d/example-token`],
    });
  }
  if (buttons.length > 0) components.push({ type: "BUTTONS", buttons });

  return { name: definition.name, language: TEMPLATE_LANGUAGE, category: "UTILITY", components };
}

export const ALL_TEMPLATE_KEYS = Object.keys(TEMPLATES) as TemplateKey[];

/** "أحمد محمد علي" -> "أحمد". A greeting with the whole of a long name reads as a form letter. */
export function firstName(fullName: string): string {
  return fullName.trim().split(/\s+/)[0] ?? fullName;
}

/**
 * "الأحد 18 أكتوبر الساعة 10:30 ص", in the clinic's own clock. Western digits on purpose: they read the
 * same on every phone, and an Arabic-Indic digit is the first thing a font fallback gets wrong.
 */
export function printedDateTime(instant: Date, timeZone: string): string {
  const day = new Intl.DateTimeFormat("ar-EG-u-nu-latn", {
    timeZone,
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(instant);
  return `${day} الساعة ${printedTime(instant, timeZone)}`;
}

export function printedTime(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("ar-EG-u-nu-latn", { timeZone, hour: "numeric", minute: "2-digit", hour12: true }).format(
    instant,
  );
}
