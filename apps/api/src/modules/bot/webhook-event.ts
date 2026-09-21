// The body of an outbound event, and the whole of what leaves the clinic. Pure: no database import,
// so the guard that pins its key set can hold it to exactly this shape.

/** The four events the contract lists (docs/WHATSAPP-BOT-CONTRACT.md §6). */
export const WEBHOOK_EVENT_TYPES = [
  "appointment.confirmed",
  "appointment.cancelled",
  "appointment.rescheduled",
  "appointment.reminder",
] as const;

export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

/**
 * **The minimum, ruled 2026-09-18.** A first name, a time, who or what it is with, the status, and
 * our ids — never a full name, a diagnosis, a note or an invoice.
 *
 * The bot writes the sentence a patient reads, and it can write "أهلاً أحمد" from a first name. A
 * full name is the identifying half, and it would be sitting in somebody else's message logs for as
 * long as they keep them.
 */
export interface WebhookEvent {
  eventId: string;
  eventType: WebhookEventType;
  occurredAt: string;
  clinicId: string;
  appointmentId: string;
  patientId: string;
  patientFirstName: string;
  scheduledStart: string;
  doctorName: string;
  serviceName: string;
  appointmentStatus: string;
}

/** The exact key set of every event body. The guard reads this, and so does the contract's §6. */
export const WEBHOOK_EVENT_KEYS: readonly (keyof WebhookEvent)[] = [
  "eventId",
  "eventType",
  "occurredAt",
  "clinicId",
  "appointmentId",
  "patientId",
  "patientFirstName",
  "scheduledStart",
  "doctorName",
  "serviceName",
  "appointmentStatus",
];

/**
 * The first word of a name, and nothing after it.
 *
 * Arabic names run "أحمد عبد الرحمن الشناوي": the first token is the given name, and every token
 * after it narrows down who the person is. Splitting on whitespace is enough for that, and this is
 * the one place a name is ever shortened — a stored name is never rewritten (D19's reasoning).
 */
export function firstName(fullName: string): string {
  return fullName.trim().split(/\s+/)[0] ?? "";
}

export interface EventSource {
  eventId: string;
  eventType: WebhookEventType;
  occurredAt: Date;
  clinicId: string;
  appointmentId: string;
  patientId: string;
  patientFullName: string;
  scheduledStart: Date;
  doctorName: string;
  serviceName: string;
  appointmentStatus: string;
}

/**
 * Builds the body from what the dispatcher read.
 *
 * Written key by key rather than by spreading a row: a spread carries whatever the select grew, and
 * this is the boundary where "one more field" means a clinical fact in somebody else's logs.
 */
export function buildWebhookEvent(source: EventSource): WebhookEvent {
  return {
    eventId: source.eventId,
    eventType: source.eventType,
    occurredAt: source.occurredAt.toISOString(),
    clinicId: source.clinicId,
    appointmentId: source.appointmentId,
    patientId: source.patientId,
    patientFirstName: firstName(source.patientFullName),
    scheduledStart: source.scheduledStart.toISOString(),
    doctorName: source.doctorName,
    serviceName: source.serviceName,
    appointmentStatus: source.appointmentStatus,
  };
}
