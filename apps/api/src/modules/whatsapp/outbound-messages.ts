// The outbox: reminders, the "go to the room" message, the cancellation notice and the documents link.
//
// One pass does four things, in this order, and every one is safe to run twice at once because the
// database -- a unique key, a guarded UPDATE -- is what owns exactly-once, never this process's memory:
//
//   1. sweepReminders        an appointment whose reminder is due gets an intent
//   2. supersedeStale        a reminder whose appointment moved or ended is closed
//   3. expireUnanswered      a reminder the patient did not answer in time cancels the appointment
//   4. drainDue              every intent that is due is sent
//
// ## Why a sweeper and not a delayed job per appointment
//
// "Send at start - 5h" looks like a job to schedule when the appointment is booked. It is not: the
// appointment is then described twice, once in `appointments` and once in a queue, and every reschedule,
// cancel and desk confirmation must find the job and fix it. A queue that is wiped, or that missed one
// event, silently stops reminding. Here the appointment is the only record: the sweeper asks "which
// appointments are due a reminder right now?" every minute, so a moved or cancelled appointment simply
// stops matching, and there is nothing to keep in step.
//
// ## Retry is a property of the message, not of the sender
//
// A reminder that arrives after the consultation began is worse than none, and a documents link the
// patient will want tomorrow is worth retrying all day. `KIND_POLICY` says which is which.

import { uuidv7 } from "uuidv7";
import type { Prisma } from "../../generated/prisma/client.ts";
import { prisma } from "../../prisma/client.ts";
import { injected } from "../../prisma/injected.ts";
import { withTenant, type ActorContext, type TransactionClient } from "../../prisma/with-tenant.ts";
import { systemActor } from "../audit/system-actor.ts";
import { changeAppointmentStatus, type CallerContext } from "../appointments/appointments.service.ts";
import { visitScope } from "../clinical/visit-scope.ts";
import { recordNotification } from "../notifications/notifications.service.ts";
import { resolveBotActor } from "../webchat/webchat-clinics.ts";
import { issueVisitDocumentLink, DOCUMENT_LINK_TTL_DAYS } from "../visit-documents/visit-document-links.ts";
import {
  sendWhatsAppTemplate,
  sendWhatsAppText,
  WhatsAppSendError,
  type WhatsAppTemplateSend,
} from "./whatsapp-graph-client.ts";
import { noteSendFailure } from "./whatsapp-connections.ts";
import { resolveTenantByPhoneNumberId, type ResolvedWhatsAppTenant } from "./whatsapp-tenants.ts";
import { planReminder, reminderDedupeKey } from "./reminder-plan.ts";
import {
  buildTemplateSend,
  firstName,
  printedDateTime,
  printedTime,
  reminderPayloads,
} from "./whatsapp-templates.ts";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

export type IntentKind = "APPOINTMENT_REMINDER" | "REMINDER_AUTO_CANCELLED" | "CALL_IN" | "VISIT_DOCUMENTS";

/** The reason recorded on an appointment the platform cancelled for silence. Read by the desk, in Arabic. */
export const NO_CONFIRMATION_REASON = "لم يؤكد المريض حضوره عبر واتساب";

interface KindPolicy {
  /** Waits between attempts. The attempt count is `backoffMs.length + 1`. */
  backoffMs: readonly number[];
}

/**
 * Reminder: hard, until it stops being useful (its own expiry decides that).
 * Cancellation notice and documents: hard -- the patient still wants these hours later.
 * Call-in: one more try after a minute. A patient called into a room ten minutes late is already there
 * or has gone; the desk, not a retry, handles that.
 */
const KIND_POLICY: Record<IntentKind, KindPolicy> = {
  APPOINTMENT_REMINDER: { backoffMs: [MINUTE_MS, 5 * MINUTE_MS, 15 * MINUTE_MS, HOUR_MS] },
  REMINDER_AUTO_CANCELLED: { backoffMs: [MINUTE_MS, 5 * MINUTE_MS, 15 * MINUTE_MS, HOUR_MS, 3 * HOUR_MS, 6 * HOUR_MS] },
  CALL_IN: { backoffMs: [MINUTE_MS] },
  VISIT_DOCUMENTS: { backoffMs: [MINUTE_MS, 5 * MINUTE_MS, 15 * MINUTE_MS, HOUR_MS, 3 * HOUR_MS, 6 * HOUR_MS, 12 * HOUR_MS] },
};

/**
 * Meta codes that mean this message will never go through, however often it is retried: the number is
 * not on WhatsApp, or the template is missing, unapproved, or does not match what we sent. Retrying
 * these for hours only delays the desk finding out.
 */
const PERMANENT_META_CODES = new Set([131026, 131008, 131009, 132000, 132001, 132005, 132007, 132012, 132015, 132016]);

/** "The 24-hour window is closed" for a free-form message. The one case with a fallback: the template. */
const WINDOW_CLOSED_META_CODE = 131047;

/** How long after the patient's last message a free-form reply is still allowed. A margin inside Meta's 24 hours. */
const SERVICE_WINDOW_MS = 23 * HOUR_MS;

export interface OutboundDeps {
  sendTemplate: (
    phoneNumberId: string,
    toWaId: string,
    template: WhatsAppTemplateSend,
    token?: string,
  ) => Promise<{ externalMessageId: string }>;
  sendText: (
    phoneNumberId: string,
    toWaId: string,
    body: string,
    token?: string,
  ) => Promise<{ externalMessageId: string }>;
}

const DEFAULT_DEPS: OutboundDeps = { sendTemplate: sendWhatsAppTemplate, sendText: sendWhatsAppText };

export interface PassTally {
  remindersQueued: number;
  superseded: number;
  autoCancelled: number;
  sent: number;
  retrying: number;
  failed: number;
  skipped: Record<string, number>;
}

function emptyTally(): PassTally {
  return { remindersQueued: 0, superseded: 0, autoCancelled: 0, sent: 0, retrying: 0, failed: 0, skipped: {} };
}

/** One pass. Called by `scripts/outbound-messages.ts`, once a minute or on a loop. */
export async function runOutboundPass(now: Date, deps: OutboundDeps = DEFAULT_DEPS): Promise<PassTally> {
  const tally = emptyTally();
  const tenants = await prisma.$queryRaw<{ tenantId: string }[]>`
    SELECT tenant_id AS "tenantId" FROM list_tenants_with_reminders_enabled()
  `;
  for (const { tenantId } of tenants) {
    // One clinic's failure must not stop every other clinic's reminders.
    await sweepTenant(tenantId, now, tally).catch((error: unknown) => {
      console.error(`outbound-messages: sweep failed for tenant ${tenantId}`, error);
    });
  }
  await expireUnanswered(now, tally);
  await drainDue(now, deps, tally);
  return tally;
}

// ---------------------------------------------------------------------------
// 1 + 2. The sweep
// ---------------------------------------------------------------------------

async function sweepTenant(tenantId: string, now: Date, tally: PassTally): Promise<void> {
  const actor = await systemActor();

  await withTenant(tenantId, actor, async (tx) => {
    const tenant = await tx.tenant.findUniqueOrThrow({
      where: { id: tenantId },
      select: { timezone: true, reminderLeadHours: true, reminderConfirmWindowHours: true },
    });
    const policy = { leadHours: tenant.reminderLeadHours, confirmWindowHours: tenant.reminderConfirmWindowHours };

    // Far enough ahead to catch a reminder that quiet hours pushed to the next morning.
    const horizon = new Date(now.getTime() + (tenant.reminderLeadHours + 24) * HOUR_MS);
    const appointments = await tx.appointment.findMany({
      where: { scheduledStart: { gt: now, lte: horizon }, status: { in: ["BOOKED", "CONFIRMED"] } },
      select: { id: true, scheduledStart: true, createdAt: true, status: true },
      take: 2000,
    });

    for (const appointment of appointments) {
      if (appointment.status !== "BOOKED" && appointment.status !== "CONFIRMED") continue;
      const plan = planReminder({
        scheduledStart: appointment.scheduledStart,
        bookedAt: appointment.createdAt,
        status: appointment.status,
        timeZone: tenant.timezone,
        policy,
        now,
      });
      // Not yet due: the plan will be the same next minute, so there is nothing to store until it is.
      if (plan === null || plan.sendAt.getTime() > now.getTime()) continue;

      const result = await tx.outboundMessageIntent.createMany({
        data: [
          injected<Prisma.OutboundMessageIntentCreateManyInput>({
            id: uuidv7(),
            appointmentId: appointment.id,
            kind: "APPOINTMENT_REMINDER",
            dedupeKey: reminderDedupeKey(appointment.id, appointment.scheduledStart),
            nextAttemptAt: now,
            // After this the reminder is no use: it would arrive when the patient should already be in the chair.
            expiresAt: new Date(appointment.scheduledStart.getTime() - 30 * MINUTE_MS),
            appointmentStart: appointment.scheduledStart,
            respondBy: plan.respondBy,
          }),
        ],
        skipDuplicates: true,
      });
      tally.remindersQueued += result.count;
    }

    // Close the reminders of appointments that have since moved or ended, so a late tap or the expiry
    // sweep cannot act on an appointment the reminder was never about.
    const open = await tx.outboundMessageIntent.findMany({
      where: { kind: "APPOINTMENT_REMINDER", status: "SENT", respondedAt: null },
      select: {
        id: true,
        appointmentStart: true,
        appointment: { select: { status: true, scheduledStart: true } },
      },
      take: 500,
    });
    const stale = open.filter(
      (row) =>
        (row.appointment.status !== "BOOKED" && row.appointment.status !== "CONFIRMED") ||
        row.appointment.scheduledStart.getTime() !== row.appointmentStart?.getTime(),
    );
    if (stale.length > 0) {
      const result = await tx.outboundMessageIntent.updateMany({
        where: { id: { in: stale.map((row) => row.id) }, respondedAt: null },
        data: { respondedAt: now, skippedReason: "SUPERSEDED" },
      });
      tally.superseded += result.count;
    }
  });
}

// ---------------------------------------------------------------------------
// 3. The patient did not answer
// ---------------------------------------------------------------------------

async function expireUnanswered(now: Date, tally: PassTally): Promise<void> {
  const due = await prisma.$queryRaw<{ intentId: string; tenantId: string }[]>`
    SELECT intent_id AS "intentId", tenant_id AS "tenantId" FROM list_expired_reminders(${now}, ${50})
  `;
  for (const { intentId, tenantId } of due) {
    try {
      if (await expireOne(intentId, tenantId, now)) tally.autoCancelled += 1;
    } catch (error) {
      console.error(`outbound-messages: could not expire reminder ${intentId}`, error);
    }
  }
}

/** The caller the platform acts as when it cancels: the clinic's own bot membership, never a person. */
export async function botCaller(tenantId: string): Promise<CallerContext | null> {
  const bot = await resolveBotActor(tenantId);
  if (bot === null) return null;
  return {
    tenantId,
    actor: { userId: bot.userId, ip: "whatsapp", userAgent: "clinic-os-reminders" },
    role: "AI_AGENT",
    membershipId: bot.membershipId,
  };
}

/**
 * Returns true if this call cancelled the appointment.
 *
 * Claims the reminder first, with a guarded UPDATE (`responded_at IS NULL`): a patient's tap and this
 * sweep can arrive in the same second, and exactly one of them gets `count = 1`. The loser does nothing.
 */
async function expireOne(intentId: string, tenantId: string, now: Date): Promise<boolean> {
  const actor = await systemActor();

  const claimed = await withTenant(tenantId, actor, async (tx) => {
    const intent = await tx.outboundMessageIntent.findFirst({
      where: { id: intentId, status: "SENT", respondedAt: null },
      select: {
        id: true,
        appointmentId: true,
        appointmentStart: true,
        appointment: { select: { status: true, scheduledStart: true } },
      },
    });
    if (intent === null) return null;

    const unchanged =
      intent.appointment.status === "BOOKED" &&
      intent.appointment.scheduledStart.getTime() === intent.appointmentStart?.getTime();

    const result = await tx.outboundMessageIntent.updateMany({
      where: { id: intentId, respondedAt: null },
      data: unchanged
        ? { respondedAt: now, response: "EXPIRED" }
        // Reception confirmed it, it moved, or it ended in the meantime: silence is no longer the patient's.
        : { respondedAt: now, skippedReason: "SUPERSEDED" },
    });
    if (result.count !== 1 || !unchanged) return null;
    return { appointmentId: intent.appointmentId };
  });
  if (claimed === null) return false;

  const caller = await botCaller(tenantId);
  if (caller === null) return false;

  const outcome = await changeAppointmentStatus(caller, claimed.appointmentId, "CANCEL", {
    reason: NO_CONFIRMATION_REASON,
    now,
  });
  if (!outcome.ok) {
    console.warn(`outbound-messages: auto-cancel of ${claimed.appointmentId} refused: ${outcome.code}`);
    return false;
  }

  // Tell the patient. A template: nobody who has not answered us is inside the free-form window.
  await withTenant(tenantId, actor, (tx) =>
    tx.outboundMessageIntent.createMany({
      data: [
        injected<Prisma.OutboundMessageIntentCreateManyInput>({
          id: uuidv7(),
          appointmentId: claimed.appointmentId,
          kind: "REMINDER_AUTO_CANCELLED",
          dedupeKey: `auto-cancelled:${intentId}`,
          nextAttemptAt: now,
        }),
      ],
      skipDuplicates: true,
    }),
  );
  return true;
}

// ---------------------------------------------------------------------------
// 4. Sending
// ---------------------------------------------------------------------------

export async function drainDue(now: Date, deps: OutboundDeps, tally: PassTally): Promise<void> {
  const due = await prisma.$queryRaw<{ intentId: string; tenantId: string }[]>`
    SELECT intent_id AS "intentId", tenant_id AS "tenantId" FROM list_due_message_intents(${now}, ${100})
  `;
  for (const { intentId, tenantId } of due) {
    try {
      const outcome = await sendIntent(intentId, tenantId, now, deps);
      if (outcome.result === "sent") tally.sent += 1;
      else if (outcome.result === "retrying") tally.retrying += 1;
      else if (outcome.result === "failed") tally.failed += 1;
      else if (outcome.result === "skipped") tally.skipped[outcome.reason] = (tally.skipped[outcome.reason] ?? 0) + 1;
    } catch (error) {
      // An unexpected fault (not a Meta refusal) leaves the intent PENDING and due: the next pass retries it.
      console.error(`outbound-messages: intent ${intentId} errored`, error);
    }
  }
}

export type SendOutcome =
  | { result: "sent" }
  | { result: "retrying" }
  | { result: "failed" }
  | { result: "skipped"; reason: string };

async function resolveTenantForSending(tenantId: string): Promise<ResolvedWhatsAppTenant | null> {
  const row = await prisma.tenant.findFirst({
    where: { id: tenantId, status: "ACTIVE" },
    select: { whatsappPhoneNumberId: true },
  });
  if (row?.whatsappPhoneNumberId == null) return null;
  return resolveTenantByPhoneNumberId(row.whatsappPhoneNumberId);
}

/** Whether this patient has said yes to WhatsApp, now rather than when the reason for the message arose. */
async function hasWhatsAppConsent(tx: TransactionClient, patientId: string): Promise<boolean> {
  const latest = await tx.consent.findFirst({
    where: { patientId, purpose: "WHATSAPP_COMMS" },
    orderBy: { grantedAt: "desc" },
    select: { granted: true, withdrawnAt: true },
  });
  return latest !== null && latest.granted && latest.withdrawnAt === null;
}

interface Loaded {
  intent: {
    id: string;
    kind: IntentKind;
    attempts: number;
    expiresAt: Date | null;
    appointmentStart: Date | null;
    respondBy: Date | null;
    appointmentId: string;
  };
  appointment: { status: string; scheduledStart: Date };
  patient: { id: string; fullNameAr: string; phoneE164: string };
  doctorName: string;
  where: string;
  clinicName: string;
  timeZone: string;
  consent: boolean;
  lastInboundAt: Date | null;
  visitId: string | null;
}

async function load(
  tx: TransactionClient,
  tenantId: string,
  intentId: string,
  actor: ActorContext,
): Promise<Loaded | null> {
  const intent = await tx.outboundMessageIntent.findFirst({ where: { id: intentId, status: "PENDING" } });
  if (intent === null) return null;

  const appointment = await tx.appointment.findFirst({
    where: { id: intent.appointmentId },
    select: {
      status: true,
      scheduledStart: true,
      patient: { select: { id: true, fullNameAr: true, phoneE164: true } },
      doctor: {
        select: {
          title: true,
          roomNumber: true,
          printedName: true,
          membership: { select: { user: { select: { fullName: true } } } },
        },
      },
    },
  });
  if (appointment === null) return null;

  const tenant = await tx.tenant.findUniqueOrThrow({
    where: { id: tenantId },
    select: { name: true, timezone: true },
  });

  const lastInbound = await tx.message.findFirst({
    where: { direction: "INBOUND", contact: { phoneE164: appointment.patient.phoneE164 } },
    orderBy: { sentAt: "desc" },
    select: { sentAt: true },
  });

  const visit =
    intent.kind === "VISIT_DOCUMENTS"
      ? await tx.visit.findFirst({
          where: { appointmentId: intent.appointmentId, status: "COMPLETED", ...visitScope({ actor }) },
          select: { id: true },
        })
      : null;

  const rawName = appointment.doctor.printedName ?? appointment.doctor.membership.user.fullName;
  const doctorName = `${appointment.doctor.title} ${rawName}`.trim();
  const room = appointment.doctor.roomNumber?.trim();

  return {
    intent: {
      id: intent.id,
      kind: intent.kind as IntentKind,
      attempts: intent.attempts,
      expiresAt: intent.expiresAt,
      appointmentStart: intent.appointmentStart,
      respondBy: intent.respondBy,
      appointmentId: intent.appointmentId,
    },
    appointment: { status: appointment.status, scheduledStart: appointment.scheduledStart },
    patient: appointment.patient,
    doctorName,
    where: room ? `غرفة ${room} - ${doctorName}` : `عيادة ${doctorName}`,
    clinicName: tenant.name,
    timeZone: tenant.timezone,
    consent: await hasWhatsAppConsent(tx, appointment.patient.id),
    lastInboundAt: lastInbound?.sentAt ?? null,
    visitId: visit?.id ?? null,
  };
}

/** A reason this message should not be sent at all, decided from the state of the world right now. */
function skipReason(loaded: Loaded, now: Date): string | null {
  const { intent, appointment } = loaded;
  if (intent.expiresAt !== null && intent.expiresAt.getTime() <= now.getTime()) return "EXPIRED";
  if (!loaded.consent) return "NO_CONSENT";

  switch (intent.kind) {
    case "APPOINTMENT_REMINDER":
      if (appointment.status !== "BOOKED" && appointment.status !== "CONFIRMED") return "APPOINTMENT_CHANGED";
      if (appointment.scheduledStart.getTime() !== intent.appointmentStart?.getTime()) return "APPOINTMENT_CHANGED";
      return null;
    case "CALL_IN":
      // The doctor started and finished in one transaction (completing from WAITING does), or paused.
      return appointment.status === "IN_CONSULTATION" ? null : "NOT_IN_CONSULTATION";
    case "VISIT_DOCUMENTS":
      return loaded.visitId === null ? "NO_COMPLETED_VISIT" : null;
    case "REMINDER_AUTO_CANCELLED":
      return null;
  }
}

const PREVIEW: Record<IntentKind, string> = {
  APPOINTMENT_REMINDER: "تذكير بالموعد",
  REMINDER_AUTO_CANCELLED: "إلغاء الموعد لعدم التأكيد",
  CALL_IN: "دعوة للدخول إلى الطبيب",
  VISIT_DOCUMENTS: "رابط مستندات الزيارة",
};

function callInText(loaded: Loaded): string {
  return `مرحباً ${firstName(loaded.patient.fullNameAr)}، حان دورك الآن. تفضّل بالدخول إلى ${loaded.where}.`;
}

export async function sendIntent(intentId: string, tenantId: string, now: Date, deps: OutboundDeps): Promise<SendOutcome> {
  const actor = await systemActor();
  const loaded = await withTenant(tenantId, actor, (tx) => load(tx, tenantId, intentId, actor));
  if (loaded === null) return { result: "skipped", reason: "GONE" };

  const skip = skipReason(loaded, now);
  if (skip !== null) return skipped(tenantId, actor, intentId, skip, now);

  const tenant = await resolveTenantForSending(tenantId);
  if (tenant === null) return skipped(tenantId, actor, intentId, "NO_WHATSAPP", now);

  const waId = loaded.patient.phoneE164.replace(/\D/g, "");
  if (waId === "") return skipped(tenantId, actor, intentId, "NO_PHONE", now);

  try {
    const sent = await deliver(loaded, tenant, tenantId, waId, now, actor, deps);
    await withTenant(tenantId, actor, async (tx) => {
      await tx.outboundMessageIntent.update({
        where: { id: intentId },
        data: {
          status: "SENT",
          attempts: { increment: 1 },
          sentAt: now,
          externalMessageId: sent.externalMessageId,
          lastError: null,
        },
      });
      await logMessage(tx, {
        phoneE164: loaded.patient.phoneE164,
        waId,
        externalMessageId: sent.externalMessageId,
        kind: loaded.intent.kind,
        freeForm: sent.freeForm,
        now,
      });
    });
    return { result: "sent" };
  } catch (error) {
    return failed(tenantId, actor, loaded, error, now);
  }
}

/** Builds and sends the message for this intent's kind. Throws what Meta throws. */
async function deliver(
  loaded: Loaded,
  tenant: ResolvedWhatsAppTenant,
  tenantId: string,
  waId: string,
  now: Date,
  actor: ActorContext,
  deps: OutboundDeps,
): Promise<{ externalMessageId: string; freeForm: boolean }> {
  const { intent } = loaded;
  const name = firstName(loaded.patient.fullNameAr);
  const when = printedDateTime(loaded.appointment.scheduledStart, loaded.timeZone);
  const send = async (template: WhatsAppTemplateSend): Promise<{ externalMessageId: string; freeForm: boolean }> => ({
    ...(await deps.sendTemplate(tenant.phoneNumberId, waId, template, tenant.accessToken)),
    freeForm: false,
  });

  switch (intent.kind) {
    case "APPOINTMENT_REMINDER": {
      const payloads = reminderPayloads(intent.id);
      const base = [name, loaded.clinicName, loaded.doctorName, when];
      return send(
        intent.respondBy === null
          ? buildTemplateSend("reminderPlain", { params: base, quickReplyPayloads: payloads })
          : buildTemplateSend("reminderWithDeadline", {
              params: [...base, printedTime(intent.respondBy, loaded.timeZone)],
              quickReplyPayloads: payloads,
            }),
      );
    }

    case "REMINDER_AUTO_CANCELLED":
      return send(
        buildTemplateSend("autoCancelled", { params: [name, loaded.clinicName, loaded.doctorName, when] }),
      );

    case "CALL_IN": {
      const windowOpen =
        loaded.lastInboundAt !== null && now.getTime() - loaded.lastInboundAt.getTime() < SERVICE_WINDOW_MS;
      const template = buildTemplateSend("callIn", { params: [name, loaded.where] });
      if (!windowOpen) return send(template);
      try {
        return {
          ...(await deps.sendText(tenant.phoneNumberId, waId, callInText(loaded), tenant.accessToken)),
          freeForm: true,
        };
      } catch (error) {
        // Our estimate of the window was wrong (a patient's message arrived on another device, a clock
        // skew): the template is the answer to "the window is closed", not a failure.
        if (error instanceof WhatsAppSendError && error.metaCode === WINDOW_CLOSED_META_CODE) return send(template);
        throw error;
      }
    }

    case "VISIT_DOCUMENTS": {
      if (loaded.visitId === null) throw new Error("VISIT_DOCUMENTS intent reached delivery with no visit.");
      const visitId = loaded.visitId;
      // A fresh token per attempt; the previous attempt's is revoked inside issueVisitDocumentLink.
      const { token } = await withTenant(tenantId, actor, (tx) =>
        issueVisitDocumentLink(tx, { visitId, intentId: intent.id, now }),
      );
      return send(
        buildTemplateSend("visitDocuments", {
          params: [name, loaded.clinicName, String(DOCUMENT_LINK_TTL_DAYS)],
          urlButtonSuffix: token,
        }),
      );
    }
  }
}

async function skipped(
  tenantId: string,
  actor: ActorContext,
  intentId: string,
  reason: string,
  now: Date,
): Promise<SendOutcome> {
  await withTenant(tenantId, actor, (tx) =>
    tx.outboundMessageIntent.updateMany({
      where: { id: intentId, status: "PENDING" },
      data: { status: "SKIPPED", skippedReason: reason, updatedAt: now },
    }),
  );
  return { result: "skipped", reason };
}

async function failed(
  tenantId: string,
  actor: ActorContext,
  loaded: Loaded,
  error: unknown,
  now: Date,
): Promise<SendOutcome> {
  const { intent } = loaded;
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 500);
  const permanent = error instanceof WhatsAppSendError && error.metaCode !== null && PERMANENT_META_CODES.has(error.metaCode);
  if (error instanceof WhatsAppSendError) await noteSendFailure(tenantId, error);

  const backoff = KIND_POLICY[intent.kind].backoffMs;
  const wait = backoff[intent.attempts];
  const next = wait === undefined ? null : new Date(now.getTime() + wait);
  const expired = next !== null && intent.expiresAt !== null && next.getTime() >= intent.expiresAt.getTime();

  if (!permanent && next !== null && !expired) {
    await withTenant(tenantId, actor, (tx) =>
      tx.outboundMessageIntent.update({
        where: { id: intent.id },
        data: { attempts: { increment: 1 }, nextAttemptAt: next, lastError: message },
      }),
    );
    return { result: "retrying" };
  }

  await withTenant(tenantId, actor, async (tx) => {
    await tx.outboundMessageIntent.update({
      where: { id: intent.id },
      data: { status: "FAILED", attempts: { increment: 1 }, failedAt: now, lastError: message },
    });
    // The desk must hear that this patient was never told -- the one thing nobody else can see.
    const appointment = await tx.appointment.findFirst({
      where: { id: intent.appointmentId },
      select: { patientId: true, source: true, scheduledStart: true },
    });
    if (appointment !== null) {
      await recordNotification(tx, actor.userId, {
        kind: "WHATSAPP_MESSAGE_FAILED",
        appointmentId: intent.appointmentId,
        patientId: appointment.patientId,
        source: appointment.source,
        occurredAt: now,
        payload: {
          patientName: loaded.patient.fullNameAr,
          start: appointment.scheduledStart.toISOString(),
          reason: PREVIEW[intent.kind],
        },
      });
    }
  });
  return { result: "failed" };
}

/**
 * Keeps the clinic's own record of the message. A template goes to a patient who may never have written,
 * so the contact and conversation may not exist yet; they are created the way an inbound message would.
 * `last_message_at` is left alone: it decides whether the patient's next message opens a new session, and
 * a reminder sent by us is not the patient being in the middle of a conversation.
 */
async function logMessage(
  tx: TransactionClient,
  input: { phoneE164: string; waId: string; externalMessageId: string; kind: IntentKind; freeForm: boolean; now: Date },
): Promise<void> {
  const contact =
    (await tx.contact.findFirst({ where: { phoneE164: input.phoneE164 }, select: { id: true } })) ??
    (await tx.contact.create({
      data: injected({ id: uuidv7(), phoneE164: input.phoneE164, whatsappOptIn: true }),
      select: { id: true },
    }));

  const conversation =
    (await tx.conversation.findFirst({ where: { contactId: contact.id, status: "OPEN" }, select: { id: true } })) ??
    (await tx.conversation.create({
      data: injected({
        id: uuidv7(),
        contactId: contact.id,
        channel: "whatsapp",
        externalConversationId: input.waId,
        status: "OPEN",
        openedAt: input.now,
      }),
      select: { id: true },
    }));

  await tx.message.create({
    data: injected({
      id: uuidv7(),
      conversationId: conversation.id,
      contactId: contact.id,
      direction: "OUTBOUND",
      messageType: input.freeForm ? "TEXT" : "TEMPLATE",
      externalMessageId: input.externalMessageId,
      bodyPreview: PREVIEW[input.kind],
      status: "SENT",
      // Meta bills every message sent through the API since 1 October 2026, inside the window or not.
      billable: true,
      billingCategory: input.freeForm ? "SERVICE" : "UTILITY",
      sentAt: input.now,
    }),
  });
}
