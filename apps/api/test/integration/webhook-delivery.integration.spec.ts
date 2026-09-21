import { randomUUID } from "node:crypto";
import { uuidv7 } from "uuidv7";
import { prisma } from "../../src/prisma/client.ts";
import { injected } from "../../src/prisma/injected.ts";
import { withTenant } from "../../src/prisma/with-tenant.ts";
import { generateWebhookSecret, verifyWebhookSignature } from "../../src/modules/bot/webhook-signing.ts";
import { WEBHOOK_EVENT_KEYS } from "../../src/modules/bot/webhook-event.ts";
import {
  BACKOFF_MS,
  dispatchDueDeliveries,
  REMINDER_LEAD_MS,
  sweepReminders,
} from "../../src/modules/bot/webhook-dispatch.ts";
import { ensureWhatsAppConsent } from "../../src/modules/bot/bot.service.ts";
import { actorFor, type ClinicFixture, seedClinic, teardownClinic } from "./fixtures.ts";

/**
 * The outbound half: queued by the act, gated on consent, signed, retried, and given up on loudly.
 *
 * The consent test is the one that matters most. A reminder to a patient who never agreed to be
 * messaged on WhatsApp is the clinic breaking a promise on our behalf, and it is not recoverable by
 * apologising afterwards.
 */
describe("the webhook outbox", () => {
  let clinic: ClinicFixture;
  let webhookSecret = "";
  const WEBHOOK_URL = "https://bot.example.test/hook";

  /** Everything the dispatcher sent, so a test can read the headers and the body it produced. */
  const sent: { url: string; headers: Record<string, string>; body: string }[] = [];
  let respondWith = 200;
  /** A10: the dispatcher checks where a webhook resolves. This spec's host is fictional, so the
   *  lookup is injected the way `fetch` is — and one test below points it inward on purpose. */
  const publicResolve = async (): Promise<string[]> => ["93.184.216.34"];
  let throwWith: Error | null = null;

  const fakeFetch = async (
    url: string,
    init: { method: string; headers: Record<string, string>; body: string },
  ): Promise<{ status: number }> => {
    sent.push({ url, headers: init.headers, body: init.body });
    if (throwWith !== null) throw throwWith;
    return { status: respondWith };
  };

  const asClinic = async <T>(fn: (tx: Parameters<Parameters<typeof withTenant>[2]>[0]) => Promise<T>): Promise<T> =>
    withTenant(clinic.tenantId, actorFor(clinic.userId), fn);

  /** An appointment tomorrow, which is what a reminder is about. */
  const bookAppointment = async (start: Date): Promise<string> => {
    const id = uuidv7();
    await asClinic(async (tx) => {
      await tx.appointment.create({
        data: injected({
          id,
          patientId: clinic.patientId,
          doctorId: clinic.doctorId,
          serviceId: clinic.serviceId,
          scheduledStart: start,
          scheduledEnd: new Date(start.getTime() + 30 * 60_000),
          status: "BOOKED",
          source: "WHATSAPP",
          createdBy: clinic.userId,
          updatedBy: clinic.userId,
        }),
      });
    });
    return id;
  };

  const grantConsent = async (granted: boolean): Promise<void> => {
    await asClinic(async (tx) => {
      await tx.consent.create({
        data: injected({
          id: uuidv7(),
          patientId: clinic.patientId,
          purpose: "WHATSAPP_COMMS",
          granted,
          grantedAt: new Date(),
          withdrawnAt: granted ? null : new Date(),
          capturedByUserId: clinic.userId,
          evidence: { channel: "whatsapp" },
        }),
      });
    });
  };

  const deliveries = async (): Promise<
    { id: string; eventType: string; skippedReason: string | null; deliveredAt: Date | null; attempts: number }[]
  > =>
    asClinic(async (tx) =>
      tx.webhookDelivery.findMany({
        select: { id: true, eventType: true, skippedReason: true, deliveredAt: true, attempts: true },
        orderBy: { createdAt: "asc" },
      }),
    );

  /**
   * The dispatcher's due-list is cross-tenant by design, so a run sees every clinic's outbox. These
   * assertions are about this clinic's rows, and a neighbour left over from another spec is not a
   * reason for one of them to fail.
   */
  const mine = async (outcomes: { deliveryId: string }[]): Promise<unknown[]> => {
    const ids = new Set((await deliveries()).map((row) => row.id));
    return outcomes.filter((outcome) => ids.has(outcome.deliveryId));
  };

  beforeAll(async () => {
    clinic = await seedClinic();

    // A live credential with somewhere to call: the trigger queues nothing for a clinic without one.
    webhookSecret = generateWebhookSecret();
    const botUserId = uuidv7();
    await prisma.user.create({
      data: {
        id: botUserId,
        phoneE164: `+999${String(Math.floor(Math.random() * 1e11)).padStart(11, "0")}`,
        passwordHash: "not-a-real-hash",
        fullName: "WhatsApp bot",
        status: "ACTIVE",
      },
    });
    await asClinic(async (tx) => {
      const membershipId = uuidv7();
      await tx.membership.create({
        data: injected({ id: membershipId, userId: botUserId, role: "AI_AGENT", status: "ACTIVE" }),
      });
      await tx.botCredential.create({
        data: injected({
          id: uuidv7(),
          membershipId,
          secretHash: "not-a-real-hash",
          issuedByUserId: clinic.userId,
          issuedAt: new Date(),
          webhookUrl: WEBHOOK_URL,
          webhookSecret,
        }),
      });
    });
  });

  afterAll(async () => {
    await teardownClinic(clinic);
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    sent.length = 0;
    respondWith = 200;
    throwWith = null;
    await asClinic(async (tx) => {
      await tx.webhookDelivery.deleteMany({});
      await tx.consent.deleteMany({ where: { purpose: "WHATSAPP_COMMS" } });

      // Each test sweeps the whole clinic, so yesterday's appointments would be swept again today.
      // `appointment_events` is append-only, so an appointment that has one stays — and it is
      // cancelled instead, which is a status no reminder is sent for.
      const withEvents = await tx.appointmentEvent.findMany({ select: { appointmentId: true } });
      const keep = withEvents.map((event) => event.appointmentId);
      await tx.appointment.deleteMany({ where: { id: { notIn: keep.length === 0 ? [randomUUID()] : keep } } });
      if (keep.length > 0) {
        await tx.appointment.updateMany({ where: { id: { in: keep } }, data: { status: "CANCELLED" } });
      }
    });
  });

  test("a reminder for a patient who never consented is never emitted", async () => {
    const now = new Date();
    await bookAppointment(new Date(now.getTime() + 2 * 60 * 60_000));

    expect(await sweepReminders(now)).toBe(1);
    const outcomes = await mine(await dispatchDueDeliveries(now, { fetch: fakeFetch, resolve: publicResolve }));

    expect(outcomes).toEqual([expect.objectContaining({ result: "skipped", reason: "NO_CONSENT" })]);
    expect(sent).toEqual([]);

    // Recorded, not discarded: "nobody was told" must be a fact somebody can look up.
    expect((await deliveries()).map((row) => row.skippedReason)).toEqual(["NO_CONSENT"]);
  });

  test("a withdrawn consent is a refusal too, read at send time and not at booking", async () => {
    const now = new Date();
    await grantConsent(true);
    await bookAppointment(new Date(now.getTime() + 2 * 60 * 60_000));
    expect(await sweepReminders(now)).toBe(1);

    // The patient changes their mind after the reminder was queued.
    await grantConsent(false);

    const outcomes = await mine(await dispatchDueDeliveries(now, { fetch: fakeFetch, resolve: publicResolve }));
    expect(outcomes).toEqual([expect.objectContaining({ result: "skipped", reason: "NO_CONSENT" })]);
    expect(sent).toEqual([]);
  });

  test("a consented reminder is delivered, signed, idempotent, and carries only the allowed keys", async () => {
    const now = new Date();
    await grantConsent(true);
    const appointmentId = await bookAppointment(new Date(now.getTime() + 2 * 60 * 60_000));
    await sweepReminders(now);

    const outcomes = await mine(await dispatchDueDeliveries(now, { fetch: fakeFetch, resolve: publicResolve }));
    expect(outcomes).toEqual([expect.objectContaining({ result: "delivered" })]);
    expect(sent).toHaveLength(1);

    const delivery = sent[0];
    if (delivery === undefined) throw new Error("nothing was sent");
    expect(delivery.url).toBe(WEBHOOK_URL);

    const body = JSON.parse(delivery.body) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual([...WEBHOOK_EVENT_KEYS].sort());
    expect(body["appointmentId"]).toBe(appointmentId);
    expect(body["eventType"]).toBe("appointment.reminder");

    // The idempotency key is the delivery's own id, so a retry cannot become a second message.
    const queued = await deliveries();
    expect(delivery.headers["x-idempotency-key"]).toBe(queued[0]?.id);

    expect(
      verifyWebhookSignature(
        webhookSecret,
        delivery.headers["x-clinic-timestamp"] ?? "",
        delivery.body,
        delivery.headers["x-clinic-signature"] ?? "",
        now,
      ),
    ).toBe(true);
  });

  test("the full name never leaves, only the first", async () => {
    const now = new Date();
    await grantConsent(true);
    await bookAppointment(new Date(now.getTime() + 2 * 60 * 60_000));
    await sweepReminders(now);
    await dispatchDueDeliveries(now, { fetch: fakeFetch, resolve: publicResolve });

    const stored = await asClinic(async (tx) =>
      tx.patient.findFirstOrThrow({ where: { id: clinic.patientId }, select: { fullNameAr: true } }),
    );
    const [given, ...rest] = stored.fullNameAr.trim().split(/\s+/);
    const body = sent[0]?.body ?? "";
    expect(body).toContain(given ?? "");
    for (const part of rest) expect(body).not.toContain(part);
  });

  test("booking, rescheduling and cancelling each queue their own event", async () => {
    // The enqueue is a database trigger on `appointment_events`, so it cannot be forgotten by a new
    // code path: this writes the events directly and asserts the outbox followed.
    const now = new Date();
    const appointmentId = await bookAppointment(new Date(now.getTime() + 2 * 60 * 60_000));

    await asClinic(async (tx) => {
      for (const eventType of ["CREATED", "RESCHEDULED", "CANCELLED", "NOTE_ADDED"] as const) {
        await tx.appointmentEvent.create({
          data: injected({
            id: uuidv7(),
            appointmentId,
            eventType,
            actorUserId: clinic.userId,
            createdAt: new Date(),
          }),
        });
      }
    });

    expect((await deliveries()).map((row) => row.eventType).sort()).toEqual([
      "appointment.cancelled",
      "appointment.confirmed",
      "appointment.rescheduled",
    ]);
  });

  test("a non-2xx is retried with backoff, then given up on and written to the audit trail", async () => {
    const now = new Date();
    await grantConsent(true);
    await bookAppointment(new Date(now.getTime() + 2 * 60 * 60_000));
    await sweepReminders(now);

    respondWith = 500;
    let at = now;
    for (let attempt = 1; attempt <= BACKOFF_MS.length; attempt += 1) {
      const outcomes = await mine(await dispatchDueDeliveries(at, { fetch: fakeFetch, resolve: publicResolve }));
      expect(outcomes).toEqual([expect.objectContaining({ result: "retrying", attempts: attempt })]);
      at = new Date(at.getTime() + (BACKOFF_MS[attempt - 1] ?? 0));
    }

    const last = await mine(await dispatchDueDeliveries(at, { fetch: fakeFetch, resolve: publicResolve }));
    expect(last).toEqual([expect.objectContaining({ result: "failed", attempts: BACKOFF_MS.length + 1 })]);
    expect(sent).toHaveLength(BACKOFF_MS.length + 1);

    // Every attempt carried the same idempotency key, which is what stops a retry becoming a second
    // message to the patient.
    const keys = new Set(sent.map((request) => request.headers["x-idempotency-key"]));
    expect(keys.size).toBe(1);

    const audited = await asClinic(async (tx) =>
      tx.auditLog.findMany({ where: { entityType: "webhook_deliveries" }, select: { newState: true, actorRole: true } }),
    );
    expect(audited).toHaveLength(1);
    expect(audited[0]?.actorRole).toBe("SYSTEM");
    expect(JSON.stringify(audited[0]?.newState)).toContain("appointment.reminder");
  });

  test("a network error is a retry, not a delivery", async () => {
    const now = new Date();
    await grantConsent(true);
    await bookAppointment(new Date(now.getTime() + 2 * 60 * 60_000));
    await sweepReminders(now);

    throwWith = new Error("socket hang up");
    expect(await mine(await dispatchDueDeliveries(now, { fetch: fakeFetch, resolve: publicResolve }))).toEqual([
      expect.objectContaining({ result: "retrying", attempts: 1 }),
    ]);
  });

  test("a booking in chat records the consent it rests on, once, and never overturns a withdrawal", async () => {
    const ctx = { tenantId: clinic.tenantId, actor: actorFor(clinic.userId) };
    await ensureWhatsAppConsent(ctx, clinic.patientId, "wamid.FIRST", new Date());
    await ensureWhatsAppConsent(ctx, clinic.patientId, "wamid.SECOND", new Date());

    const rows = await asClinic(async (tx) =>
      tx.consent.findMany({
        where: { patientId: clinic.patientId, purpose: "WHATSAPP_COMMS" },
        select: { granted: true, evidence: true },
      }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.evidence).toMatchObject({ channel: "whatsapp", externalMessageId: "wamid.FIRST" });

    // The patient says no. A later booking does not decide otherwise on their behalf.
    await grantConsent(false);
    await ensureWhatsAppConsent(ctx, clinic.patientId, "wamid.THIRD", new Date());

    const after = await asClinic(async (tx) =>
      tx.consent.findMany({
        where: { patientId: clinic.patientId, purpose: "WHATSAPP_COMMS" },
        orderBy: { grantedAt: "desc" },
        select: { granted: true },
      }),
    );
    expect(after).toHaveLength(2);
    expect(after[0]?.granted).toBe(false);
  });

  test("two sweeps produce one reminder, and nothing outside the lead window", async () => {
    const now = new Date();
    await bookAppointment(new Date(now.getTime() + 2 * 60 * 60_000));
    // Well past tomorrow: queued when its own day comes, not now.
    await bookAppointment(new Date(now.getTime() + REMINDER_LEAD_MS + 60 * 60_000));

    expect(await sweepReminders(now)).toBe(1);
    expect(await sweepReminders(now)).toBe(0);
    expect((await deliveries()).filter((row) => row.eventType === "appointment.reminder")).toHaveLength(1);
  });

  test("A10: a URL that has started resolving inward is not called", async () => {
    // Set-time validation cannot promise this — DNS is not a promise. The name passed when it was
    // registered; today it answers 10.0.0.5, and the dispatcher must decline rather than deliver a
    // patient's first name to something inside our own network.
    const now = new Date();
    await grantConsent(true);
    await bookAppointment(new Date(now.getTime() + 2 * 60 * 60_000));
    await sweepReminders(now);

    const inward = async (): Promise<string[]> => ["10.0.0.5"];
    const outcomes = await mine(await dispatchDueDeliveries(now, { fetch: fakeFetch, resolve: inward }));

    expect(outcomes).toEqual([expect.objectContaining({ result: "skipped", reason: "PRIVATE_ADDRESS" })]);
    expect(sent).toEqual([]);
    // Recorded, like every other skip: "we did not call it" is a fact somebody can look up.
    expect((await deliveries()).map((row) => row.skippedReason)).toEqual(["PRIVATE_ADDRESS"]);
  });

  test("another clinic's delivery is invisible, and unreachable", async () => {
    const other = await seedClinic();
    try {
      const now = new Date();
      await withTenant(other.tenantId, actorFor(other.userId), async (tx) => {
        const appointmentId = uuidv7();
        await tx.appointment.create({
          data: injected({
            id: appointmentId,
            patientId: other.patientId,
            doctorId: other.doctorId,
            serviceId: other.serviceId,
            scheduledStart: new Date(now.getTime() + 60 * 60_000),
            scheduledEnd: new Date(now.getTime() + 90 * 60_000),
            status: "BOOKED",
            source: "RECEPTION",
            createdBy: other.userId,
            updatedBy: other.userId,
          }),
        });
        await tx.webhookDelivery.create({
          data: injected({
            id: randomUUID(),
            appointmentId,
            eventType: "appointment.reminder",
            occurredAt: now,
            nextAttemptAt: now,
          }),
        });
      });

      // Read as this clinic: the other clinic's row is not there to be seen.
      expect(await deliveries()).toEqual([]);
    } finally {
      await teardownClinic(other);
    }
  });
});
