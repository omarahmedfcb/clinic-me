// The doctor's own open consultations, for the visit screen's tab bar. Q35.
// One query for the whole bar: it is rendered beside a draft that is autosaving, not on a timer.

import { withTenant } from "../../prisma/with-tenant.ts";
import type { CallerContext } from "../appointments/appointments.service.ts";
import { doctorIdForMembership } from "./clinical.access.ts";
import { calendarDayIn } from "../appointments/domain/zoned-time.ts";
import { clinicDayBounds } from "../queue/queue.day.ts";
import { appointmentDoctorScope } from "./visit-scope.ts";

export interface OpenVisit {
  appointmentId: string;
  patientId: string;
  patientName: string;
  status: "IN_CONSULTATION" | "PAUSED";
  /** The caller's own draft on this appointment, or null when they have not opened one yet. */
  visitId: string | null;
}

/**
 * Every consultation this doctor currently has open — Q17's "as many as they have unfinished
 * visits", made visible.
 *
 * **PAUSED counts** (Q34): a patient who stepped out for imaging is exactly the case a second tab
 * exists for, and dropping them from the bar would leave the doctor with a draft they cannot
 * navigate back to.
 *
 * A doctor with no doctor row gets an empty list rather than a refusal: the tab bar is decoration on
 * a screen whose own gate has already run, and a 403 there would replace a working screen with an
 * error over a strip of tabs.
 *
 * ## Today, and why the filter is not optional
 *
 * The first version had no date filter, and the founder's review found a doctor with three tabs open.
 * The reason is not the seed: **an `IN_CONSULTATION` row that nobody completes stays open forever**,
 * so a consultation interrupted last Tuesday is still open on Friday, and a tab bar without a date
 * accumulates them for the life of the clinic. The review database showed exactly that — three rows
 * for one doctor spanning fifteen days.
 *
 * The day is the **clinic's own**, resolved by `clinicDayBounds` — the same function the queue uses,
 * because "which day is this appointment on" is a question PHASE-3.md Q12 rules must have one
 * implementation. A clinic running past midnight has patients whose day is yesterday's date.
 */
export async function listOpenVisits(caller: CallerContext, now: Date): Promise<OpenVisit[]> {
  return withTenant(caller.tenantId, caller.actor, async (tx) => {
    const callerDoctorId = await doctorIdForMembership(tx, caller.membershipId);
    if (callerDoctorId === null) return [];

    const tenant = await tx.tenant.findUniqueOrThrow({
      where: { id: caller.tenantId },
      select: { timezone: true },
    });
    const { dayStart, dayEnd } = await clinicDayBounds(
      tx,
      calendarDayIn(now, tenant.timezone),
      tenant.timezone,
    );

    const appointments = await tx.appointment.findMany({
      where: {
        doctorId: callerDoctorId,
        status: { in: ["IN_CONSULTATION", "PAUSED"] },
        scheduledStart: { gte: dayStart, lt: dayEnd },
      },
      select: {
        id: true,
        patientId: true,
        status: true,
        scheduledStart: true,
        patient: { select: { fullNameAr: true } },
      },
      orderBy: { scheduledStart: "asc" },
    });
    if (appointments.length === 0) return [];

    // The caller's own drafts, batched. `appointmentDoctorScope` pairs appointment with doctor, so
    // a colleague's draft on the same appointment (Q15) is not reported — and `createdBy` narrows it
    // further to this caller, because a draft is the author's and not the doctor row's.
    const drafts = await tx.visit.findMany({
      where: {
        status: "DRAFT",
        createdBy: caller.actor.userId,
        ...appointmentDoctorScope(
          appointments.map((row) => ({ appointmentId: row.id, doctorId: callerDoctorId })),
        ),
      },
      select: { id: true, appointmentId: true },
    });
    const byAppointment = new Map(drafts.map((draft) => [draft.appointmentId, draft.id]));

    return appointments.map((row) => ({
      appointmentId: row.id,
      patientId: row.patientId,
      patientName: row.patient?.fullNameAr ?? "",
      status: row.status as "IN_CONSULTATION" | "PAUSED",
      visitId: byAppointment.get(row.id) ?? null,
    }));
  });
}
