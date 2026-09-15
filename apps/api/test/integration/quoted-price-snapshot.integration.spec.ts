import {
  bookAppointment,
  findAvailableSlots,
  rescheduleAppointment,
  type CallerContext,
} from "../../src/modules/appointments/appointments.service.ts";
import { prisma } from "../../src/prisma/client.ts";
import { injected } from "../../src/prisma/injected.ts";
import { withTenant } from "../../src/prisma/with-tenant.ts";
import { actorFor, seedClinic, teardownClinic, type ClinicFixture } from "./fixtures.ts";

/**
 * `appointments.quoted_price_minor` — PHASE-4.md §5, PHASE-5-DESIGN.md §2.2.
 *
 * The column exists because `appointments` otherwise records what an appointment costs only as a
 * live join to `services.price_minor`, which is a mutable row. Clinic-managed services is the
 * feature that starts mutating it, and on the day it ships every past appointment would silently
 * reprice itself — unrecoverably, since the old value was never written down.
 *
 * So the test that matters is not "the column is populated". It is **"editing a price does not
 * move an appointment already booked"**, which is the failure the column was added to prevent and
 * the only one that cannot be noticed by looking at a screen.
 */
describe("the quoted price is snapshotted at booking, not joined afterwards", () => {
  let fixture: ClinicFixture;
  let caller: CallerContext;

  /** A Tuesday well clear of any Egyptian DST transition, matching the other booking suites. */
  const DATE = "2026-09-01";
  const NOW = new Date("2026-08-25T06:00:00Z");
  const SEEDED_PRICE = 10_000;

  beforeAll(async () => {
    fixture = await seedClinic();
    caller = {
      tenantId: fixture.tenantId,
      actor: actorFor(fixture.userId),
      role: "RECEPTIONIST",
      membershipId: fixture.membershipId,
    };

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

  async function tokens(): Promise<string[]> {
    const result = await findAvailableSlots(caller, {
      doctorId: fixture.doctorId,
      serviceId: fixture.serviceId,
      date: DATE,
      channel: "STAFF",
      now: NOW,
    });
    if (!result.ok) throw new Error(`availability failed: ${result.code}`);
    return result.slots.map((slot) => slot.token);
  }

  async function quotedPriceOf(appointmentId: string): Promise<number | null> {
    return withTenant(fixture.tenantId, actorFor(fixture.userId), async (tx) => {
      const row = await tx.appointment.findFirst({ where: { id: appointmentId } });
      return row?.quotedPriceMinor ?? null;
    });
  }

  async function setServicePrice(priceMinor: number): Promise<void> {
    await withTenant(fixture.tenantId, actorFor(fixture.userId), async (tx) => {
      await tx.service.update({ where: { id: fixture.serviceId }, data: { priceMinor } });
    });
  }

  test("booking writes the service's price onto the appointment", async () => {
    const [token] = await tokens();
    const booked = await bookAppointment(caller, {
      slotToken: token!,
      patientId: fixture.patientId,
      source: "RECEPTION",
      now: NOW,
    });
    if (!booked.ok) throw new Error(`booking failed: ${booked.code}`);

    // Read the row, not the return value: the point is what reached the database.
    await expect(quotedPriceOf(booked.appointmentId)).resolves.toBe(SEEDED_PRICE);
  });

  test("editing the service price leaves an appointment already booked untouched", async () => {
    const [token] = await tokens();
    const booked = await bookAppointment(caller, {
      slotToken: token!,
      patientId: fixture.patientId,
      source: "RECEPTION",
      now: NOW,
    });
    if (!booked.ok) throw new Error(`booking failed: ${booked.code}`);

    await setServicePrice(45_000);
    try {
      // This is the whole reason the column exists. A join to services.price_minor would return
      // 45,000 here and there would be no way to discover that it ever meant 10,000.
      await expect(quotedPriceOf(booked.appointmentId)).resolves.toBe(SEEDED_PRICE);

      const [nextToken] = await tokens();
      const afterChange = await bookAppointment(caller, {
        slotToken: nextToken!,
        patientId: fixture.patientId,
        source: "RECEPTION",
        now: NOW,
      });
      if (!afterChange.ok) throw new Error(`booking failed: ${afterChange.code}`);

      // And the new booking is quoted the new price, or the snapshot would just be a stale cache.
      await expect(quotedPriceOf(afterChange.appointmentId)).resolves.toBe(45_000);
    } finally {
      await setServicePrice(SEEDED_PRICE);
    }
  });

  test("rescheduling re-takes the quote, because it can move the appointment to another service", async () => {
    const available = await tokens();
    const booked = await bookAppointment(caller, {
      slotToken: available[0]!,
      patientId: fixture.patientId,
      source: "RECEPTION",
      now: NOW,
    });
    if (!booked.ok) throw new Error(`booking failed: ${booked.code}`);

    await setServicePrice(33_000);
    try {
      const moved = await rescheduleAppointment(caller, booked.appointmentId, available[1]!, NOW);
      if (!moved.ok) throw new Error(`reschedule failed: ${moved.code}`);

      // `rescheduleAppointment` writes `serviceId` from the new token, so a quote left behind would
      // be a recorded fact about a service the appointment is no longer for.
      await expect(quotedPriceOf(booked.appointmentId)).resolves.toBe(33_000);
    } finally {
      await setServicePrice(SEEDED_PRICE);
    }
  });

  test("the database refuses a negative quote, whatever the code path", async () => {
    const [token] = await tokens();
    const booked = await bookAppointment(caller, {
      slotToken: token!,
      patientId: fixture.patientId,
      source: "RECEPTION",
      now: NOW,
    });
    if (!booked.ok) throw new Error(`booking failed: ${booked.code}`);

    // Deliberately breaking what the CHECK guards, rather than trusting that adding it worked.
    // A DTO bound would not survive this write; the constraint has to.
    await expect(
      withTenant(fixture.tenantId, actorFor(fixture.userId), (tx) =>
        tx.appointment.update({
          where: { id: booked.appointmentId },
          data: { quotedPriceMinor: -1 },
        }),
      ),
    ).rejects.toThrow(/appointments_quoted_price_minor_non_negative/);
  });
});
