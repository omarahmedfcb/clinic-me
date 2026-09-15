import { randomUUID } from "node:crypto";
import {
  bookAppointment,
  findAvailableSlots,
  type CallerContext,
} from "../../src/modules/appointments/appointments.service.ts";
import { prisma } from "../../src/prisma/client.ts";
import { injected } from "../../src/prisma/injected.ts";
import { withTenant } from "../../src/prisma/with-tenant.ts";
import { actorFor, seedClinic, teardownClinic, type ClinicFixture } from "./fixtures.ts";

/**
 * The Phase 2 gate (ARCHITECTURE.md §20): "double-booking verified under concurrency".
 *
 * ## What this is really testing
 *
 * Not that the engine is careful. That the engine is **not trusted**. Availability is computed at
 * one instant and acted on at another, and between the two anyone may book — a receptionist, the
 * WhatsApp agent, a second receptionist. `no_double_booking` is the only thing that decides, and
 * it decides at the moment of the insert.
 *
 * So the interesting number is not "one succeeded". It is that the losers get a clean,
 * actionable `SLOT_TAKEN` rather than an unhandled driver error — because an unhandled `23P01`
 * becomes a 500, and a 500 tells a receptionist the system is broken when in fact the world simply
 * moved on. Losing this race is the design working.
 *
 * There is deliberately **no application-level "is it still free?" check** in `bookAppointment`.
 * Such a check reads, decides, and then writes, and every one of those gaps is a race it loses
 * silently. ARCHITECTURE.md §9 is explicit: "Application-level checks race under concurrency; this
 * constraint cannot be bypassed."
 */
describe("booking under concurrency", () => {
  let fixture: ClinicFixture;
  let caller: CallerContext;

  /** A Tuesday well clear of any Egyptian DST transition. */
  const DATE = "2026-09-01";
  const NOW = new Date("2026-08-25T06:00:00Z");

  beforeAll(async () => {
    fixture = await seedClinic();
    caller = { tenantId: fixture.tenantId, actor: actorFor(fixture.userId), role: "RECEPTIONIST", membershipId: fixture.membershipId };

    await withTenant(fixture.tenantId, actorFor(fixture.userId), async (tx) => {
      await tx.scheduleTemplate.create({
        data: injected({
          doctorId: fixture.doctorId,
          weekday: 2, // Tuesday, JS getDay()
          startTime: new Date(Date.UTC(1970, 0, 1, 9, 0, 0)),
          endTime: new Date(Date.UTC(1970, 0, 1, 12, 0, 0)),
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

  async function offeredTokens(count: number): Promise<string[]> {
    const result = await findAvailableSlots(caller, {
      doctorId: fixture.doctorId,
      serviceId: fixture.serviceId,
      date: DATE,
      channel: "STAFF",
      now: NOW,
    });
    if (!result.ok) throw new Error(`availability failed: ${result.code}`);
    expect(result.slots.length).toBeGreaterThan(0);
    // The SAME slot, offered many times over — which is exactly what happens when several people
    // load the day view at once. Every one of these tokens is individually valid.
    return Array.from({ length: count }, () => result.slots[0]!.token);
  }

  /** Distinct patients, so nothing but the slot itself can be the reason for a collision. */
  async function extraPatients(count: number): Promise<string[]> {
    return withTenant(fixture.tenantId, actorFor(fixture.userId), async (tx) => {
      const ids: string[] = [];
      for (let i = 0; i < count; i += 1) {
        const id = randomUUID();
        await tx.patient.create({
          data: injected({
            id,
            fullNameAr: `Racer ${i}`,
            phoneE164: `+2012${id.replace(/-/g, "").slice(0, 8)}`,
            relationshipToContact: "SELF",
            status: "ACTIVE",
          }),
        });
        ids.push(id);
      }
      return ids;
    });
  }

  /**
   * **Back on jest's 5-second default, and the reason it can be is the point.**
   *
   * For a few hours on 2026-09-06 this test carried an explicit 30-second budget. That was not a
   * weakened assertion -- every expectation was unchanged -- but it was a symptom: the `40P01`
   * deadlock this suite stresses was being *retried* rather than prevented, and `deadlock_timeout`
   * is `1s` on this cluster, so eight contending transactions could spend several seconds simply
   * waiting for Postgres to notice cycles. One of three consecutive full runs failed here on the
   * timeout rather than on an assertion.
   *
   * The advisory doctor-day lock removed the collision instead of recovering from it, and with it
   * the variance went too: ten consecutive runs at the default, slowest whole-suite time 3.2 s for
   * all three tests plus fixture setup. Measured before the budget was handed back, not assumed.
   */
  test("N parallel bookings of one slot: exactly one wins, the rest get SLOT_TAKEN", async () => {
    const N = 8;
    const [tokens, patients] = await Promise.all([offeredTokens(N), extraPatients(N)]);

    // In flight together, or the test proves only that sequential inserts work — which they
    // trivially do.
    //
    // `allSettled`, not `all`, and the reason is a defect this suite has actually hit. Under
    // `Promise.all` a `bookAppointment` that *throws* rejects the whole array, and jest reports
    // the await on this line with no trace of what was thrown — which is exactly what happened on
    // CI run 33256221701 and on roughly one local run in ten. Booking is supposed to return
    // `SLOT_TAKEN` rather than throw, so a rejection here is a real finding and the test must be
    // able to say what it was rather than swallowing it into a bare stack.
    const settled = await Promise.allSettled(
      tokens.map((slotToken, i) =>
        bookAppointment(caller, {
          slotToken,
          patientId: patients[i]!,
          source: "RECEPTION",
          now: NOW,
        }),
      ),
    );

    const thrown = settled
      .filter((r): r is PromiseRejectedResult => r.status === "rejected")
      .map((r) => {
        const e = r.reason as { name?: string; code?: string; message?: string; meta?: unknown };
        return {
          name: e?.name,
          code: e?.code,
          message: String(e?.message ?? "").slice(0, 300),
          meta: JSON.stringify(e?.meta ?? null).slice(0, 300),
        };
      });

    // Reported as data, so the next occurrence names its own cause instead of costing another
    // afternoon of re-running the suite to catch it.
    expect({ threw: thrown.length, errors: thrown }).toEqual({ threw: 0, errors: [] });

    const results = settled
      .filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof bookAppointment>>> =>
        r.status === "fulfilled",
      )
      .map((r) => r.value);

    const winners = results.filter((r) => r.ok);
    const losers = results.filter((r) => !r.ok);

    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(N - 1);

    // Every loser must lose for the RIGHT reason. Without this the test would pass if all seven
    // failed because the token was malformed, or the patient was missing.
    for (const loser of losers) {
      expect(loser).toMatchObject({ ok: false, code: "SLOT_TAKEN" });
    }

    // And the database agrees: one row, not eight, and not zero.
    const stored = await withTenant(fixture.tenantId, actorFor(fixture.userId), (tx) =>
      tx.appointment.findMany({ where: { doctorId: fixture.doctorId } }),
    );
    expect(stored).toHaveLength(1);
    expect(stored[0]!.id).toBe((winners[0] as { appointmentId: string }).appointmentId);
  });

  /**
   * A different slot on the same day must still be bookable while the first one is contended.
   * Without this, a constraint that rejected *everything* would pass the test above.
   */
  test("a different slot is unaffected", async () => {
    const availability = await findAvailableSlots(caller, {
      doctorId: fixture.doctorId,
      serviceId: fixture.serviceId,
      date: DATE,
      channel: "STAFF",
      now: NOW,
    });
    if (!availability.ok) throw new Error("availability failed");

    // The taken slot is gone from the offer, which is the engine agreeing with the database.
    expect(availability.slots).not.toHaveLength(0);
    const [patient] = await extraPatients(1);

    const result = await bookAppointment(caller, {
      slotToken: availability.slots[0]!.token,
      patientId: patient!,
      source: "RECEPTION",
      now: NOW,
    });
    expect(result.ok).toBe(true);
  });

  /**
   * The losers' answer has to be actionable. `SLOT_TAKEN` maps to 409 and its detail tells the
   * caller what to do next; an unhandled 23P01 would map to 500 and tell a receptionist the
   * system is broken when the world merely moved.
   */
  test("a taken slot booked again returns SLOT_TAKEN, not a thrown driver error", async () => {
    const taken = await withTenant(fixture.tenantId, actorFor(fixture.userId), (tx) =>
      tx.appointment.findFirst({ where: { doctorId: fixture.doctorId } }),
    );
    expect(taken).not.toBeNull();

    const availability = await findAvailableSlots(caller, {
      doctorId: fixture.doctorId,
      serviceId: fixture.serviceId,
      date: DATE,
      channel: "STAFF",
      now: NOW,
    });
    if (!availability.ok) throw new Error("availability failed");

    // Rebuild a token for a slot that is now occupied, by asking for availability as it stood
    // before the booking — the honest way to reproduce "the list in your hand is stale".
    const stale = await findAvailableSlots(caller, {
      doctorId: fixture.doctorId,
      serviceId: fixture.serviceId,
      date: DATE,
      channel: "STAFF",
      now: NOW,
    });
    if (!stale.ok) throw new Error("availability failed");

    const [patient] = await extraPatients(1);
    const first = await bookAppointment(caller, {
      slotToken: stale.slots[0]!.token,
      patientId: patient!,
      source: "RECEPTION",
      now: NOW,
    });
    expect(first.ok).toBe(true);

    const [second] = await extraPatients(1);
    const again = await bookAppointment(caller, {
      slotToken: stale.slots[0]!.token,
      patientId: second!,
      source: "RECEPTION",
      now: NOW,
    });
    expect(again).toMatchObject({ ok: false, code: "SLOT_TAKEN" });
  });
});
