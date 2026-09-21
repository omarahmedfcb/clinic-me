// Delivering the outbox. docs/WHATSAPP-BOT-CONTRACT.md §6: signed, idempotent, retried with
// backoff, and never sent to a patient who has not consented to WhatsApp.

import { uuidv7 } from "uuidv7";
import { prisma } from "../../prisma/client.ts";
import { injected } from "../../prisma/injected.ts";
import { withTenant } from "../../prisma/with-tenant.ts";
import { systemActor } from "../audit/system-actor.ts";
import { buildWebhookEvent, type WebhookEventType } from "./webhook-event.ts";
import { checkWebhookAddress, resolveHostname } from "./webhook-address.ts";
import { webhookHeaders } from "./webhook-signing.ts";

/**
 * How long we keep trying, and how long we wait between attempts.
 *
 * Seven attempts spanning a little under 23 hours, inside the contract's 24. Backoff rather than a
 * fixed interval because the failures worth surviving are a deploy and a certificate renewal, which
 * last minutes, and the ones not worth hammering are a URL that is simply wrong, which lasts until
 * somebody fixes it.
 */
export const BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000, 3 * 60 * 60_000, 6 * 60 * 60_000, 12 * 60 * 60_000];

/** How far ahead a reminder is queued. One day: the contract's reminder is "tomorrow's visit". */
export const REMINDER_LEAD_MS = 24 * 60 * 60_000;

/** A delivery that reaches this without a 2xx is given up on, and the give-up is audited. */
export const MAX_ATTEMPTS = BACKOFF_MS.length + 1;

/** Statuses a reminder is worth sending for. A cancelled or finished visit needs no reminder. */
const REMINDABLE = ["BOOKED", "CONFIRMED"] as const;

export type DeliveryOutcome =
  | { result: "delivered"; deliveryId: string }
  | { result: "retrying"; deliveryId: string; attempts: number }
  | { result: "failed"; deliveryId: string; attempts: number }
  | {
      result: "skipped";
      deliveryId: string;
      reason: "NO_CONSENT" | "NO_WEBHOOK" | "PATIENT_GONE" | "PRIVATE_ADDRESS";
    };

/** Injected so a test can assert what was sent without a network, and a script can pass `fetch`. */
export interface DispatchDeps {
  fetch: (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ status: number }>;
  /** Injected like `fetch`, so a test can exercise the address rule without touching DNS. */
  resolve?: (hostname: string) => Promise<string[]>;
  timeoutMs?: number;
}

interface DueDelivery {
  deliveryId: string;
  tenantId: string;
}

/**
 * Whether this patient has said yes to WhatsApp, **now** rather than when the event happened.
 *
 * Consent is read at send time on purpose: a patient who withdrew it between booking and the
 * reminder must not be messaged, and the event was queued before anyone could know that.
 */
async function hasWhatsAppConsent(tx: Parameters<Parameters<typeof withTenant>[2]>[0], patientId: string): Promise<boolean> {
  const latest = await tx.consent.findFirst({
    where: { patientId, purpose: "WHATSAPP_COMMS" },
    orderBy: { grantedAt: "desc" },
    select: { granted: true, withdrawnAt: true },
  });
  return latest !== null && latest.granted && latest.withdrawnAt === null;
}

/**
 * Queues one reminder per appointment starting inside the lead window.
 *
 * Idempotent by the partial unique index, not by this query: two sweeps overlapping — a cron run
 * that took longer than its interval — must not produce two reminders, and the database is the only
 * layer that can promise that.
 */
export async function sweepReminders(now: Date): Promise<number> {
  const actor = await systemActor();
  const tenants = await prisma.$queryRaw<{ tenantId: string }[]>`
    SELECT tenant_id AS "tenantId" FROM list_tenants_with_live_webhook()
  `;

  let queued = 0;
  for (const { tenantId } of tenants) {
    queued += await withTenant(tenantId, actor, async (tx) => {
      const due = await tx.appointment.findMany({
        where: {
          scheduledStart: { gte: now, lte: new Date(now.getTime() + REMINDER_LEAD_MS) },
          status: { in: [...REMINDABLE] },
        },
        select: { id: true },
      });

      let written = 0;
      for (const appointment of due) {
        try {
          await tx.webhookDelivery.create({
            data: injected({
              id: uuidv7(),
              appointmentId: appointment.id,
              eventType: "appointment.reminder",
              occurredAt: now,
              nextAttemptAt: now,
            }),
          });
          written += 1;
        } catch (error) {
          // The one reminder per appointment index did its job. Any other error is not ours to eat.
          if ((error as { code?: unknown }).code !== "P2002") throw error;
        }
      }
      return written;
    });
  }
  return queued;
}

/** One delivery, start to finish. Exported so a test can drive a single row deterministically. */
export async function dispatchOne(delivery: DueDelivery, now: Date, deps: DispatchDeps): Promise<DeliveryOutcome> {
  const actor = await systemActor();

  return withTenant(delivery.tenantId, actor, async (tx) => {
    const row = await tx.webhookDelivery.findFirst({
      where: { id: delivery.deliveryId, deliveredAt: null, failedAt: null, skippedReason: null },
      select: { id: true, appointmentId: true, eventType: true, occurredAt: true, attempts: true },
    });
    if (row === null) return { result: "skipped" as const, deliveryId: delivery.deliveryId, reason: "PATIENT_GONE" as const };

    const credential = await tx.botCredential.findFirst({
      where: { revokedAt: null },
      select: { webhookUrl: true, webhookSecret: true },
    });

    const skip = async (
      reason: "NO_CONSENT" | "NO_WEBHOOK" | "PATIENT_GONE" | "PRIVATE_ADDRESS",
    ): Promise<DeliveryOutcome> => {
      await tx.webhookDelivery.update({ where: { id: row.id }, data: { skippedReason: reason } });
      return { result: "skipped", deliveryId: row.id, reason };
    };

    if (credential?.webhookUrl == null || credential.webhookSecret == null) return skip("NO_WEBHOOK");

    // A10, at send time: DNS is not a promise. The URL passed this check when it was set; whether
    // it still points outward is a question only answerable now.
    const address = await checkWebhookAddress(credential.webhookUrl, {
      resolve: deps.resolve ?? resolveHostname,
    });
    if (!address.ok) return skip("PRIVATE_ADDRESS");

    const appointment = await tx.appointment.findFirst({
      where: { id: row.appointmentId },
      select: {
        id: true,
        status: true,
        scheduledStart: true,
        patient: { select: { id: true, fullNameAr: true } },
        doctor: { select: { membership: { select: { user: { select: { fullName: true } } } } } },
        service: { select: { nameAr: true } },
      },
    });
    if (appointment === null) return skip("PATIENT_GONE");

    // **The gate.** Nothing about an unconsented patient leaves this function, including their
    // first name: the skip is recorded against the delivery, which carries no personal detail.
    if (!(await hasWhatsAppConsent(tx, appointment.patient.id))) return skip("NO_CONSENT");

    const body = JSON.stringify(
      buildWebhookEvent({
        eventId: row.id,
        eventType: row.eventType as WebhookEventType,
        occurredAt: row.occurredAt,
        clinicId: delivery.tenantId,
        appointmentId: appointment.id,
        patientId: appointment.patient.id,
        patientFullName: appointment.patient.fullNameAr,
        scheduledStart: appointment.scheduledStart,
        doctorName: appointment.doctor?.membership?.user?.fullName ?? "",
        serviceName: appointment.service?.nameAr ?? "",
        appointmentStatus: appointment.status,
      }),
    );

    const attempts = row.attempts + 1;
    let status = 0;
    let error = "";
    try {
      const response = await deps.fetch(credential.webhookUrl, {
        method: "POST",
        headers: webhookHeaders(credential.webhookSecret, body, row.id, now),
        body,
      });
      status = response.status;
    } catch (thrown) {
      error = thrown instanceof Error ? thrown.message : String(thrown);
    }

    if (status >= 200 && status < 300) {
      await tx.webhookDelivery.update({
        where: { id: row.id },
        data: { deliveredAt: now, attempts, lastStatus: status, lastError: null },
      });
      return { result: "delivered", deliveryId: row.id };
    }

    const backoff = BACKOFF_MS[attempts - 1];
    if (backoff === undefined) {
      await tx.webhookDelivery.update({
        where: { id: row.id },
        data: { failedAt: now, attempts, lastStatus: status || null, lastError: error || `HTTP ${status}` },
      });
      return { result: "failed", deliveryId: row.id, attempts };
    }

    await tx.webhookDelivery.update({
      where: { id: row.id },
      data: {
        attempts,
        nextAttemptAt: new Date(now.getTime() + backoff),
        lastStatus: status || null,
        lastError: error || `HTTP ${status}`,
      },
    });
    return { result: "retrying", deliveryId: row.id, attempts };
  });
}

/** Everything owed at `now`, oldest first. Called by scripts/webhook-dispatch.mjs, from cron. */
export async function dispatchDueDeliveries(now: Date, deps: DispatchDeps, limit = 200): Promise<DeliveryOutcome[]> {
  const due = await prisma.$queryRaw<DueDelivery[]>`
    SELECT delivery_id AS "deliveryId", tenant_id AS "tenantId"
    FROM list_due_webhook_deliveries(${now}::timestamptz, ${limit}::integer)
  `;

  const outcomes: DeliveryOutcome[] = [];
  for (const delivery of due) outcomes.push(await dispatchOne(delivery, now, deps));
  return outcomes;
}
