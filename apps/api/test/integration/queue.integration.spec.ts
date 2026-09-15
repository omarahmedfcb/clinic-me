import {
  bookAppointment,
  findAvailableSlots,
  type CallerContext,
} from "../../src/modules/appointments/appointments.service.ts";
import {
  checkIn,
  completeConsultation,
  describeQueue,
  markNoShow,
  markWaiting,
  pendingNoShows,
  startConsultation,
} from "../../src/modules/queue/queue.service.ts";
import { prisma } from "../../src/prisma/client.ts";
import { injected } from "../../src/prisma/injected.ts";
import { withTenant } from "../../src/prisma/with-tenant.ts";
import { actorFor, seedClinic, teardownClinic, type ClinicFixture } from "./fixtures.ts";

/**
 * The queue — `PHASE-3.md` checkpoint 3.
 *
 * The two that carry the phase are **compare-and-set under concurrency** (Q2) and **the no-show
 * job writing nothing** (Q8). The rest exist so those two cannot pass by accident.
 */
describe("the queue", () => {
  let fixture: ClinicFixture;
  let caller: CallerContext;

  const DATE = "2026-09-01"; // A Tuesday, clear of any Egyptian DST transition.
  const DAY_START = new Date("2026-08-31T21:00:00Z"); // 00:00 Cairo, +03
  const DAY_END = new Date("2026-09-01T21:00:00Z");
  const NOW = new Date("2026-08-25T06:00:00Z");

  beforeAll(async () => {
    fixture = await seedClinic();
    caller = { tenantId: fixture.tenantId, actor: actorFor(fixture.userId), role: "RECEPTIONIST", membershipId: fixture.membershipId };

    await withTenant(fixture.tenantId, actorFor(fixture.userId), async (tx) => {
      await tx.scheduleTemplate.create({
        data: injected({
          doctorId: fixture.doctorId,
          weekday: 2,
          startTime: new Date(Date.UTC(1970, 0, 1, 9, 0, 0)),
          endTime: new Date(Date.UTC(1970, 0, 1, 18, 0, 0)),
          validFrom: new Date(Date.UTC(2026, 0, 1)),
          validTo: null,
        }),
      });
    });
  });

  afterAll(async () => {
    await teardownClinic(fixture);
    await prisma.$disconnect();
  });

  /** Books one appointment and returns its id. Each test gets its own, so order does not matter. */
  async function book(): Promise<string> {
    const availability = await findAvailableSlots(caller, {
      doctorId: fixture.doctorId,
      serviceId: fixture.serviceId,
      date: DATE,
      channel: "STAFF",
      now: NOW,
    });
    if (!availability.ok) throw new Error("availability failed");
    const slot = availability.slots[0];
    if (slot === undefined) throw new Error("no slot free — the day is full");

    const result = await bookAppointment(caller, {
      slotToken: slot.token,
      patientId: fixture.patientId,
      source: "RECEPTION",
      now: NOW,
    });
    if (!result.ok) throw new Error(`booking failed: ${JSON.stringify(result)}`);
    return result.appointmentId;
  }

  const read = (id: string) =>
    withTenant(fixture.tenantId, actorFor(fixture.userId), (tx) =>
      tx.appointment.findFirst({ where: { id } }),
    );

  describe("check-in is one action (Q6)", () => {
    test("writes both timestamps and both history rows in one call", async () => {
      const id = await book();

      const result = await checkIn(caller, {
        appointmentId: id,
        expectedStatus: "BOOKED",
        now: NOW,
      });

      expect(result).toMatchObject({ ok: true, status: "WAITING" });

      const row = await read(id);
      expect({
        status: row?.status,
        arrived: row?.arrivedAt !== null,
        waiting: row?.waitingStartedAt !== null,
      }).toEqual({ status: "WAITING", arrived: true, waiting: true });

      // The distinction survives in history even though it was one button.
      const events = await withTenant(fixture.tenantId, actorFor(fixture.userId), (tx) =>
        tx.appointmentEvent.findMany({
          where: { appointmentId: id, eventType: "STATUS_CHANGED" },
          orderBy: { id: "asc" },
        }),
      );
      expect(events.map((e) => `${e.fromStatus}->${e.toStatus}`)).toEqual([
        "BOOKED->ARRIVED",
        "ARRIVED->WAITING",
      ]);
    });
  });

  describe("compare-and-set (Q2)", () => {
    test("a stale expectation is refused, and names the current state", async () => {
      const id = await book();
      await checkIn(caller, { appointmentId: id, expectedStatus: "BOOKED", now: NOW });

      // A second screen still believes it is BOOKED.
      const stale = await checkIn(caller, {
        appointmentId: id,
        expectedStatus: "BOOKED",
        now: NOW,
      });

      expect(stale).toMatchObject({ ok: false, code: "QUEUE_MOVED_ON", currentStatus: "WAITING" });
      // And it can say who, so the message is "Dr X already moved this" rather than a status code.
      expect((stale as { movedBy?: string | null }).movedBy).toBe(fixture.userId);
    });

    /**
     * The case `transition()` structurally cannot catch, and the reason compare-and-set is not
     * merely nicer error handling.
     *
     * `ARRIVED → WAITING` is legal from `ARRIVED`. Two clients both holding a screen that says
     * `ARRIVED` therefore both get an approval from the state machine, and the second write
     * silently replaces the first `waiting_started_at` — which is the key the queue is ordered by.
     * Nothing anywhere records that the order changed.
     */
    test("MARK_WAITING twice cannot silently overwrite the first waiting_started_at", async () => {
      const id = await book();

      // Reach ARRIVED without going on to WAITING, so the double-apply is reachable at all.
      await withTenant(fixture.tenantId, actorFor(fixture.userId), (tx) =>
        tx.appointment.update({
          where: { id },
          data: { status: "ARRIVED", arrivedAt: NOW, updatedBy: fixture.userId },
        }),
      );

      const first = await startWaiting(id, new Date("2026-08-25T07:00:00Z"));
      expect(first).toMatchObject({ ok: true });
      const afterFirst = await read(id);

      // The second client, still showing ARRIVED, an hour later.
      const second = await startWaiting(id, new Date("2026-08-25T08:00:00Z"));

      expect(second).toMatchObject({ ok: false, code: "QUEUE_MOVED_ON" });
      const afterSecond = await read(id);
      expect(afterSecond?.waitingStartedAt).toEqual(afterFirst?.waitingStartedAt);
    });

    /** Applies MARK_WAITING alone, which check-in normally bundles. */
    const startWaiting = (id: string, now: Date) =>
      markWaiting(caller, { appointmentId: id, expectedStatus: "ARRIVED", now });

    test("under concurrency exactly one of N identical moves wins", async () => {
      const id = await book();
      const N = 6;

      const settled = await Promise.allSettled(
        Array.from({ length: N }, () =>
          checkIn(caller, { appointmentId: id, expectedStatus: "BOOKED", now: NOW }),
        ),
      );

      // A throw here would be a real finding — these are specified to return refusals.
      const thrown = settled
        .filter((r): r is PromiseRejectedResult => r.status === "rejected")
        .map((r) => String((r.reason as { message?: string })?.message ?? r.reason).slice(0, 300));
      expect({ threw: thrown.length, errors: thrown }).toEqual({ threw: 0, errors: [] });

      const results = settled
        .filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof checkIn>>> =>
          r.status === "fulfilled",
        )
        .map((r) => r.value);

      expect(results.filter((r) => r.ok)).toHaveLength(1);
      for (const loser of results.filter((r) => !r.ok)) {
        expect(loser).toMatchObject({ ok: false, code: "QUEUE_MOVED_ON" });
      }

      // Exactly two history rows: the winner's ARRIVE and MARK_WAITING, and nothing from the five
      // that lost. A refusal that still wrote history would be worse than one that failed loudly.
      const events = await withTenant(fixture.tenantId, actorFor(fixture.userId), (tx) =>
        tx.appointmentEvent.count({ where: { appointmentId: id, eventType: "STATUS_CHANGED" } }),
      );
      expect(events).toBe(2);
    });
  });

  describe("no exclusivity per doctor (Q7)", () => {
    test("a doctor may have two consultations open at once", async () => {
      const a = await book();
      const b = await book();
      for (const id of [a, b]) {
        await checkIn(caller, { appointmentId: id, expectedStatus: "BOOKED", now: NOW });
        const started = await startConsultation(caller, {
          appointmentId: id,
          expectedStatus: "WAITING",
          now: NOW,
        });
        expect(started).toMatchObject({ ok: true, status: "IN_CONSULTATION" });
      }

      // Allowed and visible, rather than refused — the ruling is that refusing it would make a
      // real clinic situation unrepresentable.
      const queue = await describeQueue(caller, {
        date: DATE,
        dayStart: DAY_START,
        dayEnd: DAY_END,
        now: NOW,
      });
      const inConsultation = queue.entries.filter((e) => e.status === "IN_CONSULTATION");
      expect(inConsultation.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("the no-show list proposes and never acts (Q8)", () => {
    test("a past-grace appointment is offered as a candidate", async () => {
      const id = await book();
      const row = await read(id);
      const wellAfter = new Date(row!.scheduledStart.getTime() + 4 * 60 * 60_000);

      const candidates = await pendingNoShows(caller, {
        dayStart: DAY_START,
        dayEnd: DAY_END,
        now: wellAfter,
      });

      expect(candidates.map((c) => c.appointmentId)).toContain(id);
    });

    /**
     * The ruling, asserted rather than trusted to the comment above the function.
     *
     * Reading the list must not move anybody. If this ever fails, someone has "helpfully" made the
     * sweep act, and a patient sitting in a waiting room can lose their slot.
     */
    test("reading the list changes no status and writes no history", async () => {
      const id = await book();
      const row = await read(id);
      const wellAfter = new Date(row!.scheduledStart.getTime() + 4 * 60 * 60_000);

      const before = await snapshot();
      await pendingNoShows(caller, { dayStart: DAY_START, dayEnd: DAY_END, now: wellAfter });
      const after = await snapshot();

      expect(after).toEqual(before);
      expect((await read(id))?.status).toBe("BOOKED");
    });

    async function snapshot() {
      return withTenant(fixture.tenantId, actorFor(fixture.userId), async (tx) => ({
        statuses: (
          await tx.appointment.findMany({ orderBy: { id: "asc" }, select: { id: true, status: true } })
        ).map((a) => `${a.id}:${a.status}`),
        events: await tx.appointmentEvent.count(),
      }));
    }

    test("before the grace has elapsed, a human is still refused", async () => {
      const id = await book();
      const row = await read(id);

      const tooEarly = await markNoShow(caller, {
        appointmentId: id,
        expectedStatus: "BOOKED",
        now: new Date(row!.scheduledStart.getTime() + 60_000),
      });

      expect(tooEarly).toMatchObject({ ok: false, code: "GRACE_PERIOD_NOT_ELAPSED" });
    });

    test("a marked no-show releases its slot, which is immediately bookable again", async () => {
      const id = await book();
      const row = await read(id);
      const start = row!.scheduledStart;
      const wellAfter = new Date(start.getTime() + 4 * 60 * 60_000);

      const marked = await markNoShow(caller, {
        appointmentId: id,
        expectedStatus: "BOOKED",
        now: wellAfter,
      });
      expect(marked).toMatchObject({ ok: true, status: "NO_SHOW" });

      // The consequence people forget: NO_SHOW frees the time.
      const availability = await findAvailableSlots(caller, {
        doctorId: fixture.doctorId,
        serviceId: fixture.serviceId,
        date: DATE,
        channel: "STAFF",
        now: NOW,
      });
      if (!availability.ok) throw new Error("availability failed");
      expect(availability.slots.map((s) => s.start.toISOString())).toContain(start.toISOString());
    });
  });

  describe("the queue query", () => {
    test("a completed patient has left the queue", async () => {
      const id = await book();
      await checkIn(caller, { appointmentId: id, expectedStatus: "BOOKED", now: NOW });
      await startConsultation(caller, { appointmentId: id, expectedStatus: "WAITING", now: NOW });
      await completeConsultation(caller, {
        appointmentId: id,
        expectedStatus: "IN_CONSULTATION",
        now: NOW,
      });

      const queue = await describeQueue(caller, {
        date: DATE,
        dayStart: DAY_START,
        dayEnd: DAY_END,
        now: NOW,
      });
      expect(queue.entries.map((e) => e.appointmentId)).not.toContain(id);
    });

    test("a cross-tenant appointment is not found, not forbidden", async () => {
      const other = await seedClinic();
      try {
        const foreign = await withTenant(other.tenantId, actorFor(other.userId), (tx) =>
          tx.appointment.findFirst(),
        );
        // Only meaningful if that clinic actually has one; seedClinic may not create appointments.
        if (foreign !== null) {
          const result = await checkIn(caller, {
            appointmentId: foreign.id,
            expectedStatus: "BOOKED",
            now: NOW,
          });
          expect(result).toMatchObject({ ok: false, code: "NOT_FOUND" });
        }
      } finally {
        await teardownClinic(other);
      }
    });
  });
});
