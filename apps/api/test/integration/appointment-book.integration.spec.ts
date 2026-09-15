import { randomUUID } from "node:crypto";
import { prisma } from "../../src/prisma/client.ts";
import { injected } from "../../src/prisma/injected.ts";
import { withTenant } from "../../src/prisma/with-tenant.ts";
import { describeMonth, listDayBookings } from "../../src/modules/appointments/month-book.ts";
import { bookAppointment, rescheduleAppointment } from "../../src/modules/appointments/appointments.service.ts";
import { mintSlotToken } from "../../src/modules/appointments/slot-token.ts";
import { actorFor, seedClinic, teardownClinic, type ClinicFixture } from "./fixtures.ts";

/**
 * «المواعيد» — the appointment book. Phase 5 PR 13.
 *
 * The guard the ruling names: **a move goes through the state machine and the exclusion
 * constraint, never a raw update.** Proven from both ends — a move into an occupied slot is
 * refused by the database, and a move of an appointment whose status forbids it is refused by the
 * state machine — because a `UPDATE appointments SET scheduled_start = ...` would pass neither and
 * is exactly what a calendar screen invites somebody to write.
 */

const MONTH = "2027-03";

async function bookAt(
  clinic: ClinicFixture,
  start: string,
  status: "BOOKED" | "COMPLETED" | "CANCELLED" = "BOOKED",
  doctorId?: string,
): Promise<string> {
  return withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) => {
    const id = randomUUID();
    await tx.appointment.create({
      data: injected({
        id,
        patientId: clinic.patientId,
        doctorId: doctorId ?? clinic.doctorId,
        serviceId: clinic.serviceId,
        scheduledStart: new Date(start),
        scheduledEnd: new Date(new Date(start).getTime() + 30 * 60_000),
        status,
        source: "RECEPTION",
        createdBy: clinic.userId,
        updatedBy: clinic.userId,
      }),
      select: { id: true },
    });
    return id;
  });
}

describe("the appointment book", () => {
  let clinic: ClinicFixture;
  const reception = () => ({
    tenantId: clinic.tenantId,
    actor: actorFor(clinic.userId),
    role: "RECEPTIONIST" as const,
    membershipId: clinic.membershipId,
  });
  const asDoctor = () => ({ ...reception(), role: "DOCTOR" as const, membershipId: clinic.membershipId });

  beforeAll(async () => {
    clinic = await seedClinic();
  });

  afterAll(async () => {
    await teardownClinic(clinic);
    await prisma.$disconnect();
  });

  test("a month counts its bookings per day and per doctor", async () => {
    await bookAt(clinic, "2027-03-04T09:00:00Z");
    await bookAt(clinic, "2027-03-04T10:00:00Z");
    await bookAt(clinic, "2027-03-05T09:00:00Z");

    const result = await describeMonth(reception(), { month: MONTH }, new Date());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const fourth = result.value.days.find((day) => day.date === "2027-03-04");
    expect(fourth?.total).toBe(2);
    expect(fourth?.byDoctor[0]).toMatchObject({ doctorId: clinic.doctorId, count: 2 });
    expect(result.value.days.find((day) => day.date === "2027-03-05")?.total).toBe(1);
  });

  test("a cancelled appointment is not a booking: counted as finished, never as standing", async () => {
    await bookAt(clinic, "2027-03-09T09:00:00Z", "CANCELLED");
    const result = await describeMonth(reception(), { month: MONTH }, new Date());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const ninth = result.value.days.find((day) => day.date === "2027-03-09");
    // A day showing one when the one was cancelled sends reception looking for a patient who is not
    // coming. It is not hidden either — the day reads as one that had something on it.
    expect(ninth?.total).toBe(0);
    expect(ninth?.finished).toBe(1);
    // And no doctor row, which would put a zero beside a name on a square read at a glance.
    expect(ninth?.byDoctor).toEqual([]);
  });

  test("the two counts are separate, never summed", async () => {
    await bookAt(clinic, "2027-03-23T09:00:00Z");
    await bookAt(clinic, "2027-03-23T10:00:00Z", "COMPLETED");
    await bookAt(clinic, "2027-03-23T11:00:00Z", "CANCELLED");

    const result = await describeMonth(reception(), { month: MONTH }, new Date());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const day = result.value.days.find((entry) => entry.date === "2027-03-23");
    expect(day?.total).toBe(1);
    expect(day?.finished).toBe(2);
    // The per-doctor breakdown is the live half only: it is what reception acts on.
    expect(day?.byDoctor).toEqual([{ doctorId: clinic.doctorId, doctorName: expect.any(String), count: 1 }]);
  });

  test("a past day opens onto the appointments its count promised", async () => {
    await bookAt(clinic, "2027-03-24T09:00:00Z", "COMPLETED");
    await bookAt(clinic, "2027-03-24T10:00:00Z", "CANCELLED");

    const result = await listDayBookings(reception(), { date: "2027-03-24" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // A square reading 2 that opens onto "nothing booked" is the panel contradicting the number
    // above it, which is what counting finished appointments on the month would otherwise produce.
    expect(result.value).toHaveLength(2);
    expect(result.value.map((booking) => booking.status).sort()).toEqual(["CANCELLED", "COMPLETED"]);
  });

  test("the day is the clinic's, not the server's", async () => {
    // 22:30 UTC on the 11th is 00:30 on the 12th in Cairo. Bucketing in UTC would file this under
    // the wrong day, and nothing about the number on the screen would look wrong.
    await withTenant(clinic.tenantId, actorFor(clinic.userId), (tx) =>
      tx.tenant.update({ where: { id: clinic.tenantId }, data: { timezone: "Africa/Cairo" } }),
    );
    await bookAt(clinic, "2027-03-11T22:30:00Z");

    const result = await describeMonth(reception(), { month: MONTH }, new Date());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.days.some((day) => day.date === "2027-03-12")).toBe(true);
    expect(result.value.days.some((day) => day.date === "2027-03-11")).toBe(false);
  });

  test("a doctor sees their own days, read-only", async () => {
    const result = await describeMonth(asDoctor(), { month: MONTH }, new Date());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The screen offers no booking and no move to a doctor — the ruling — and the payload is what
    // tells it so, rather than the screen deciding from the role on its own.
    expect(result.value.readOnly).toBe(true);
    expect(result.value.doctors.map((doctor) => doctor.id)).toEqual([clinic.doctorId]);
  });

  test("a colleague's id is not found rather than refused", async () => {
    const colleague = randomUUID();
    const result = await describeMonth(asDoctor(), { month: MONTH, doctorId: colleague }, new Date());
    // 404, never 403: confirming the id exists is the thing a 403 would do (CLAUDE.md).
    expect(result).toEqual({ ok: false, code: "NOT_FOUND", params: { resource: "doctor" } });
  });

  describe("a move goes through the state machine and the constraint, never a raw update", () => {
    test("the database refuses a move onto an occupied slot", async () => {
      const taken = "2027-03-18T09:00:00Z";
      await bookAt(clinic, taken);
      const moving = await bookAt(clinic, "2027-03-18T11:00:00Z");

      // **A raw update is what a calendar screen invites somebody to write.** This is that write,
      // and the exclusion constraint is what stops it — not the application.
      const raw = withTenant(clinic.tenantId, actorFor(clinic.userId), (tx) =>
        tx.appointment.update({
          where: { id: moving },
          data: {
            scheduledStart: new Date(taken),
            scheduledEnd: new Date(new Date(taken).getTime() + 30 * 60_000),
          },
        }),
      );
      await expect(raw).rejects.toThrow(/no_double_booking|exclusion|conflicting key/i);
    });

    test("the state machine refuses a move the status forbids", async () => {
      // A **real** token, so the refusal that comes back is the state machine's and not the token
      // check's — the token is verified first, so a forged one would prove nothing about status.
      const completed = await bookAt(clinic, "2027-03-19T09:00:00Z", "COMPLETED");
      const token = mintSlotToken(
        {
          tenantId: clinic.tenantId,
          doctorId: clinic.doctorId,
          serviceId: clinic.serviceId,
          startMs: new Date("2027-03-19T14:00:00Z").getTime(),
          endMs: new Date("2027-03-19T14:30:00Z").getTime(),
        },
        new Date(),
      );

      const result = await rescheduleAppointment(reception(), completed, token, new Date());
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(["ILLEGAL_TRANSITION", "TERMINAL_STATUS"]).toContain(result.code);

      // And the row did not move, which is the part a passing refusal could still get wrong.
      const after = await withTenant(clinic.tenantId, actorFor(clinic.userId), (tx) =>
        tx.appointment.findFirstOrThrow({ where: { id: completed }, select: { scheduledStart: true } }),
      );
      expect(after.scheduledStart.toISOString()).toBe("2027-03-19T09:00:00.000Z");
    });

    /**
     * **Nothing is booked or moved into the past** — ruled 2026-09-13.
     *
     * The engine only ever offers future slots, so a past-slot token means one outlived the time it
     * described, or was replayed. The screen hides the controls on a day that has gone; this is what
     * makes it a rule. `PAST_SLOT` rather than `EXPIRED_TOKEN` because no fresh offer would help.
     *
     * **`PAST_SLOT` wins over `EXPIRED_TOKEN` whenever the time has gone** — the founder's ruling of
     * 2026-09-13, reordering the two checks.
     *
     * It was the other way round at first: the ten-minute TTL is checked inside the token module, so
     * a token for a slot two hours ago came back `EXPIRED_TOKEN` — true, and the lesser sentence. It
     * invites the caller to ask for a fresh offer, and no offer would help. The past check now runs
     * first and reads the claims of an expired token, which are trustworthy because the signature is
     * verified before the expiry ever is.
     *
     * So the tests below come in pairs: one inside the token's live window, one long past it. Both
     * must say `PAST_SLOT`, and the second is the one the old order got wrong.
     */
    test("a move into the past is refused, and the appointment does not move", async () => {
      const booked = await bookAt(clinic, "2027-03-21T09:00:00Z");
      // A real token for a real past slot, minted at a time when it was still future — which is the
      // only way such a token can exist, and so the only thing worth testing.
      const pastStart = new Date("2027-03-21T08:00:00Z");
      const token = mintSlotToken(
        {
          tenantId: clinic.tenantId,
          doctorId: clinic.doctorId,
          serviceId: clinic.serviceId,
          startMs: pastStart.getTime(),
          endMs: pastStart.getTime() + 30 * 60_000,
        },
        new Date("2027-03-21T08:00:00Z"),
      );

      const result = await rescheduleAppointment(
        reception(),
        booked,
        token,
        // Now is after the slot it names.
        new Date("2027-03-21T08:02:00Z"),
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe("PAST_SLOT");

      const after = await withTenant(clinic.tenantId, actorFor(clinic.userId), (tx) =>
        tx.appointment.findFirstOrThrow({ where: { id: booked }, select: { scheduledStart: true } }),
      );
      expect(after.scheduledStart.toISOString()).toBe("2027-03-21T09:00:00.000Z");
    });

    test("a booking into the past is refused the same way", async () => {
      const pastStart = new Date("2027-03-22T08:00:00Z");
      const token = mintSlotToken(
        {
          tenantId: clinic.tenantId,
          doctorId: clinic.doctorId,
          serviceId: clinic.serviceId,
          startMs: pastStart.getTime(),
          endMs: pastStart.getTime() + 30 * 60_000,
        },
        new Date("2027-03-22T08:00:00Z"),
      );

      const result = await bookAppointment(reception(), {
        slotToken: token,
        patientId: clinic.patientId,
        source: "RECEPTION",
        now: new Date("2027-03-22T08:02:00Z"),
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe("PAST_SLOT");
    });

    test("a long-expired token for a past slot still says PAST_SLOT, not EXPIRED_TOKEN", async () => {
      // Two hours past the slot and well beyond the ten-minute TTL: the case the old order reported
      // as EXPIRED_TOKEN, which told the caller to ask again for a time that cannot come back.
      const booked = await bookAt(clinic, "2027-03-25T09:00:00Z");
      const pastStart = new Date("2027-03-25T08:00:00Z");
      const token = mintSlotToken(
        {
          tenantId: clinic.tenantId,
          doctorId: clinic.doctorId,
          serviceId: clinic.serviceId,
          startMs: pastStart.getTime(),
          endMs: pastStart.getTime() + 30 * 60_000,
        },
        pastStart,
      );

      const result = await rescheduleAppointment(reception(), booked, token, new Date("2027-03-25T10:00:00Z"));
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe("PAST_SLOT");
    });

    test("an expired token for a slot still ahead is an expired token, not a past one", async () => {
      // The other side of the reorder: the offer went stale but the time has not gone, so asking
      // again is exactly the right advice and EXPIRED_TOKEN is exactly the right sentence.
      const booked = await bookAt(clinic, "2027-03-26T09:00:00Z");
      const futureStart = new Date("2027-03-26T15:00:00Z");
      const token = mintSlotToken(
        {
          tenantId: clinic.tenantId,
          doctorId: clinic.doctorId,
          serviceId: clinic.serviceId,
          startMs: futureStart.getTime(),
          endMs: futureStart.getTime() + 30 * 60_000,
        },
        new Date("2027-03-26T10:00:00Z"),
      );

      // Twenty minutes later: past the TTL, hours before the slot.
      const result = await rescheduleAppointment(reception(), booked, token, new Date("2027-03-26T10:20:00Z"));
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe("EXPIRED_TOKEN");
    });

    test("a legal move still needs a slot this clinic offered", async () => {
      const booked = await bookAt(clinic, "2027-03-20T09:00:00Z");
      const result = await rescheduleAppointment(reception(), booked, "forged-token", new Date());
      expect(result.ok).toBe(false);
      if (result.ok) return;
      // The new time comes from a signed slot token, so a client cannot name an arbitrary instant —
      // which is the other half of "never a raw update".
      expect(["INVALID_TOKEN", "EXPIRED_TOKEN"]).toContain(result.code);
    });
  });
});
