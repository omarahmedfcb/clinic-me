// A patient tapped "تأكيد الحضور" or "إلغاء الموعد" on a reminder.
//
// A template's quick-reply button reaches us as a message of type `button`, carrying the payload we put
// on it when we sent: `rem:c:<intentId>` or `rem:x:<intentId>`. It is NOT run through the booking flow or
// the model -- a tap is one unambiguous act, and it must work whatever the patient was doing in the chat
// and even while a person has paused the bot.
//
// ## What stops a payload from being used on someone else's appointment
//
// The intent id is a UUID the patient was sent, so it is not a secret in the cryptographic sense: it is
// forwarded, screenshotted, read over a shoulder. What makes a tap safe is that the sender's WhatsApp
// number must equal the appointment patient's number. A payload replayed from another phone is answered
// like any other stale one and changes nothing.
//
// ## Why the claim comes before the act
//
// The expiry sweep and a tap can land in the same second. Each first claims the reminder with
// `UPDATE ... WHERE responded_at IS NULL`; only one gets a row back. The loser reports what the winner did.

import { withTenant } from "../../prisma/with-tenant.ts";
import { changeAppointmentStatus, type CallerContext } from "../appointments/appointments.service.ts";
import { botActorContext, ingestInboundMessage, recordOutboundMessage } from "./whatsapp-conversation.ts";
import { sendWhatsAppText } from "./whatsapp-graph-client.ts";
import type { ResolvedWhatsAppTenant } from "./whatsapp-tenants.ts";
import { firstName, parseReminderPayload, printedDateTime } from "./whatsapp-templates.ts";

/** The reason on an appointment the patient cancelled from the reminder. Read by the desk, in Arabic. */
export const PATIENT_CANCELLED_REASON = "ألغاه المريض عبر رسالة التذكير";

const REPLIES = {
  confirmed: (name: string, when: string): string => `تم تأكيد موعدك يوم ${when}، ${name}. ننتظرك.`,
  alreadyConfirmed: (when: string): string => `موعدك يوم ${when} مؤكد بالفعل. ننتظرك.`,
  cancelled: "تم إلغاء موعدك. يمكنك حجز موعد جديد في أي وقت بإرسال رسالة هنا.",
  alreadyCancelled: "تم إلغاء هذا الموعد. يمكنك حجز موعد جديد في أي وقت بإرسال رسالة هنا.",
  outdated: "تم تحديث موعدك منذ إرسال هذا التذكير، وسيصلك تذكير جديد بالموعد الحالي.",
  unknown: "لم نتمكن من معالجة هذا الرد. يمكنك إرسال رسالة هنا وسنساعدك.",
} as const;

export interface ReminderTap {
  tenant: ResolvedWhatsAppTenant;
  waId: string;
  phoneE164: string;
  externalMessageId: string;
  payload: string;
  /** What the button said, kept as the text of the inbound message in the clinic's chat history. */
  title: string;
  occurredAt: Date;
}

export type TapOutcome = "CONFIRMED" | "CANCELLED" | "ALREADY_ANSWERED" | "STALE" | "REJECTED" | "DUPLICATE";

/** Injected so a spec can read the reply without a network; production passes nothing. */
type SendText = (phoneNumberId: string, toWaId: string, body: string, token?: string) => Promise<{ externalMessageId: string }>;

export async function handleReminderTap(
  tap: ReminderTap,
  now: Date = new Date(),
  send: SendText = sendWhatsAppText,
): Promise<TapOutcome> {
  const parsed = parseReminderPayload(tap.payload);
  if (parsed === null) return "REJECTED";

  const { tenant } = tap;
  const actor = botActorContext(tenant.bot);

  // The tap is a message in this patient's chat like any other: logged, and deduplicated on Meta's id,
  // so a redelivered webhook cannot confirm twice or send two replies.
  const ingested = await ingestInboundMessage(tenant.id, tenant.bot, {
    waId: tap.waId,
    phoneE164: tap.phoneE164,
    externalMessageId: tap.externalMessageId,
    text: tap.title,
    occurredAt: tap.occurredAt,
    // A tap does not open a booking session, so the idle gap is irrelevant; the chat keeps whatever state it had.
    idleGapMs: Number.MAX_SAFE_INTEGER,
  });
  if (ingested.alreadyProcessed) return "DUPLICATE";

  const reply = async (text: string): Promise<void> => {
    try {
      const sent = await send(tenant.phoneNumberId, tap.waId, text, tenant.accessToken);
      await recordOutboundMessage(tenant.id, tenant.bot, {
        conversationId: ingested.conversationId,
        contactId: ingested.contactId,
        externalMessageId: sent.externalMessageId,
        text,
        now: new Date(),
      });
    } catch (error) {
      // The appointment is already in its new state; a reply that did not go is a log line, not a rollback.
      console.error("WhatsApp: could not send the reminder reply", error);
    }
  };

  const found = await withTenant(tenant.id, actor, async (tx) => {
    const intent = await tx.outboundMessageIntent.findFirst({
      where: { id: parsed.intentId, kind: "APPOINTMENT_REMINDER" },
      select: {
        id: true,
        respondedAt: true,
        response: true,
        appointmentStart: true,
        appointmentId: true,
        appointment: {
          select: {
            status: true,
            scheduledStart: true,
            patient: { select: { fullNameAr: true, phoneE164: true } },
          },
        },
      },
    });
    return intent;
  });

  // Unknown id, or somebody else's appointment: indistinguishable to the sender, and changes nothing.
  if (found === null || found.appointment.patient.phoneE164.replace(/\D/g, "") !== tap.waId) {
    await reply(REPLIES.unknown);
    return "REJECTED";
  }

  const name = firstName(found.appointment.patient.fullNameAr);
  const when = printedDateTime(found.appointment.scheduledStart, tenantTimeZone(tenant));
  const movedOn =
    found.appointmentStart === null || found.appointment.scheduledStart.getTime() !== found.appointmentStart.getTime();

  if (found.appointment.status === "CANCELLED") {
    await reply(REPLIES.alreadyCancelled);
    return "ALREADY_ANSWERED";
  }
  if (movedOn || (found.appointment.status !== "BOOKED" && found.appointment.status !== "CONFIRMED")) {
    await reply(REPLIES.outdated);
    return "STALE";
  }

  // Claim it. One of {this tap, the expiry sweep, a second tap} gets count = 1.
  const claimed = await withTenant(tenant.id, actor, (tx) =>
    tx.outboundMessageIntent.updateMany({
      where: { id: found.id, respondedAt: null },
      data: { respondedAt: now, response: parsed.action === "confirm" ? "CONFIRMED" : "CANCELLED" },
    }),
  );
  if (claimed.count !== 1) {
    // Somebody got there first. If it was the patient's own earlier tap, say what it did; if it was the
    // sweep, the appointment is cancelled and the notice is on its way.
    const winner = await withTenant(tenant.id, actor, (tx) =>
      tx.outboundMessageIntent.findFirst({ where: { id: found.id }, select: { response: true } }),
    );
    await reply(winner?.response === "CONFIRMED" ? REPLIES.alreadyConfirmed(when) : REPLIES.alreadyCancelled);
    return "ALREADY_ANSWERED";
  }

  const caller: CallerContext = {
    tenantId: tenant.id,
    actor,
    role: "AI_AGENT",
    membershipId: tenant.bot.membershipId,
  };

  if (parsed.action === "confirm") {
    // Already CONFIRMED by reception is the same answer; only a BOOKED appointment has a step to take.
    if (found.appointment.status === "BOOKED") {
      const result = await changeAppointmentStatus(caller, found.appointmentId, "CONFIRM", { now });
      if (!result.ok) {
        await reply(REPLIES.outdated);
        return "STALE";
      }
    }
    await reply(REPLIES.confirmed(name, when));
    return "CONFIRMED";
  }

  const result = await changeAppointmentStatus(caller, found.appointmentId, "CANCEL", {
    reason: PATIENT_CANCELLED_REASON,
    now,
  });
  if (!result.ok) {
    await reply(REPLIES.outdated);
    return "STALE";
  }
  await reply(REPLIES.cancelled);
  return "CANCELLED";
}

function tenantTimeZone(tenant: ResolvedWhatsAppTenant): string {
  return tenant.timezone;
}
