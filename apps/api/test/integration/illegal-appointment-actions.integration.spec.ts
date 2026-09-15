import {
  bookAppointment,
  changeAppointmentStatus,
  findAvailableSlots,
  rescheduleAppointment,
  type CallerContext,
} from "../../src/modules/appointments/appointments.service.ts";
import { injected } from "../../src/prisma/injected.ts";
import { withTenant } from "../../src/prisma/with-tenant.ts";
import { actorFor, seedClinic, teardownClinic, type ClinicFixture } from "./fixtures.ts";

/**
 * Cancel and reschedule are refused where the state machine says they are illegal.
 *
 * Founder, 1 September 2026, reporting the detail panel offering cancel on a COMPLETED
 * appointment: *"If a request to cancel a COMPLETED appointment succeeds today, hiding the button
 * changes nothing — that's the same shape as the doctor selector, twice."* So this asserts the
 * server refusal, and the UI change that accompanies it is second.
 *
 * **The two halves were not in the same state, and that is the point of testing both.**
 *
 * - **Cancel was already enforced.** `changeAppointmentStatus()` consults `transition()`, which
 *   refuses terminal statuses before it reaches the edge table. There was no hole — only no test
 *   saying so, which is indistinguishable from a hole until someone checks.
 * - **Reschedule was not enforced at all.** §9 makes reschedule a mutation of the times rather
 *   than a status change, so it never called `transition()` — and being outside the state machine
 *   put it outside every guard the state machine gives. It performed no status check whatsoever.
 *   A COMPLETED appointment could be moved to a future slot, and COMPLETED still occupies time, so
 *   it would sit there blocking a genuine booking with no status ever looking wrong.
 */
describe("illegal cancel and reschedule are refused by the service", () => {
  let clinic: ClinicFixture;
  let caller: CallerContext;

  // A Tuesday clear of any Egyptian DST transition, and a fixed "now" before it, so the fixture
  // never depends on the day the suite happens to run.
  const DATE = "2026-09-01";
  const LATER = "2026-09-08";
  const NOW = new Date("2026-08-25T06:00:00Z");

  beforeAll(async () => {
    clinic = await seedClinic();
    await withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) => {
      for (const weekday of [2]) {
        await tx.scheduleTemplate.create({
          data: injected({
            doctorId: clinic.doctorId,
            weekday,
            startTime: new Date(Date.UTC(1970, 0, 1, 9, 0, 0)),
            endTime: new Date(Date.UTC(1970, 0, 1, 18, 0, 0)),
            validFrom: new Date(Date.UTC(2026, 0, 1)),
            validTo: null,
          }),
        });
      }
    });
    caller = {
      tenantId: clinic.tenantId,
      actor: actorFor(clinic.userId),
      role: "RECEPTIONIST",
      membershipId: clinic.membershipId,
    };
  });

  afterAll(async () => {
    await teardownClinic(clinic);
  });

  /** Book a real appointment, then force it to the status under test. */
  async function appointmentAt(status: "COMPLETED" | "IN_CONSULTATION"): Promise<string> {
    const offered = await findAvailableSlots(caller, {
      doctorId: clinic.doctorId,
      serviceId: clinic.serviceId,
      date: DATE,
      channel: "STAFF",
      now: NOW,
    });
    if (!offered.ok || offered.slots.length === 0) throw new Error("no slot to book the fixture on");

    const booked = await bookAppointment(caller, {
      slotToken: offered.slots[0]!.token,
      patientId: clinic.patientId,
      source: "RECEPTION",
      now: NOW,
    });
    if (!booked.ok) throw new Error(`fixture booking failed: ${booked.code}`);

    // Set directly rather than walking the machine: the machine is what is under test, and
    // driving it here would make the fixture depend on the thing the assertion is about.
    await withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) => {
      await tx.appointment.update({ where: { id: booked.appointmentId }, data: { status } });
    });
    return booked.appointmentId;
  }

  it.each(["COMPLETED", "IN_CONSULTATION"] as const)(
    "cancelling a %s appointment is refused, with a reason supplied so nothing else can explain it",
    async (status) => {
      const id = await appointmentAt(status);
      const result = await changeAppointmentStatus(caller, id, "CANCEL", {
        // Supplied deliberately: without it a REASON_REQUIRED refusal would make this pass for
        // the wrong reason, and the test would still be green if the status check vanished.
        reason: "patient rang to cancel",
        now: NOW,
      });
      expect(result.ok).toBe(false);
      // **`ILLEGAL` is gone, and this is where the gain shows.** The service used to flatten every
      // state-machine refusal into one code; it now forwards the machine's own, so the two statuses
      // are told apart: COMPLETED is terminal, while IN_CONSULTATION simply has no CANCEL edge.
      // The old assertion could not have distinguished them, and neither could a screen.
      expect(result.ok === false && result.code).toBe(
        status === "COMPLETED" ? "TERMINAL_STATUS" : "ILLEGAL_TRANSITION",
      );
    },
  );

  it.each(["COMPLETED", "IN_CONSULTATION"] as const)(
    "rescheduling a %s appointment is refused, and the times are left alone",
    async (status) => {
      const id = await appointmentAt(status);
      const offered = await findAvailableSlots(caller, {
        doctorId: clinic.doctorId,
        serviceId: clinic.serviceId,
        date: LATER,
        channel: "STAFF",
        now: NOW,
      });
      if (!offered.ok || offered.slots.length === 0) throw new Error("no slot to move onto");

      const before = await withTenant(clinic.tenantId, actorFor(clinic.userId), (tx) =>
        tx.appointment.findFirstOrThrow({ where: { id } }),
      );

      const result = await rescheduleAppointment(caller, id, offered.slots[0]!.token, NOW);
      expect(result.ok).toBe(false);
      // ILLEGAL_TRANSITION for both here, and that is correct rather than a missed distinction:
      // reschedule asks `canReschedule` directly instead of running an event through the machine,
      // so there is no terminal-versus-no-edge difference for it to report.
      expect(result.ok === false && result.code).toBe("ILLEGAL_TRANSITION");

      // The refusal has to mean nothing was written. A check that returns ILLEGAL after the
      // update would look identical at the call site and would still have moved a finished visit.
      const after = await withTenant(clinic.tenantId, actorFor(clinic.userId), (tx) =>
        tx.appointment.findFirstOrThrow({ where: { id } }),
      );
      expect(after.scheduledStart).toEqual(before.scheduledStart);
      expect(after.rescheduleCount).toBe(before.rescheduleCount);
    },
  );
});
