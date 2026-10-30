// A follow-up books into one branch: the visit's, unless the caller names another. It searches forward
// within the booking horizon and never relocates a patient to a branch nobody chose (ruled 2026-10-29).
import { uuidv7 } from "uuidv7";
import { injected } from "../../prisma/injected.ts";
import type { TransactionClient } from "../../prisma/with-tenant.ts";
import type { CallerContext } from "../appointments/appointments.service.ts";
import { loadContext, loadWeekInput } from "../appointments/appointments.fetch.ts";
import { generateSlots } from "../appointments/domain/generate-slots.ts";
import { addDays } from "../appointments/domain/zoned-time.ts";
import type { DayPlanInput } from "../appointments/domain/types.ts";
import { lockDoctorDay } from "../appointments/slot-day-lock.ts";
import { recordNotification } from "../notifications/notifications.service.ts";

export type FollowUpBooking =
  | { booked: true; appointmentId: string; branchId: string; date: string }
  | { booked: false; branchId: string; searchedUntil: string | null };

export async function bookFollowUp(
  tx: TransactionClient,
  caller: CallerContext,
  input: { patientId: string; doctorId: string; serviceId: string; from: string; branchId: string; now: Date },
): Promise<FollowUpBooking> {
  const context = await loadContext(tx, caller.tenantId, input.doctorId, input.serviceId);
  if (!context.ok) return { booked: false, branchId: input.branchId, searchedUntil: null };

  // The same horizon every other booking obeys (findAvailableSlots): one number, not two.
  const horizonEnd = addDays(input.now.toISOString().slice(0, 10), context.tenant.bookingHorizonDays);
  if (input.from > horizonEnd) return { booked: false, branchId: input.branchId, searchedUntil: horizonEnd };

  const firstIn = (day: DayPlanInput, utcDay?: string) =>
    generateSlots({
      ...day,
      service: { durationMinutes: context.durationMinutes, bufferMinutes: context.bufferMinutes },
      granularityMinutes: context.tenant.slotGranularityMinutes,
      leadMinutes: context.tenant.bookingLeadMinutesStaff,
      now: input.now,
    }).find((s) => s.branchId === input.branchId && (utcDay === undefined || s.start.toISOString().startsWith(utcDay)));

  // D25: a doctor-day is written only under its lock, and read again once the lock is held; days
  // are tried in ascending order, so a second lock in this transaction is always taken in key order.
  const dayInput = await loadWeekInput(tx, input.doctorId, input.from, horizonEnd, context.timezone);
  let slot: { start: Date; end: Date; date: string } | undefined;
  for (let date = input.from; date <= horizonEnd && slot === undefined; date = addDays(date, 1)) {
    const candidate = firstIn(dayInput(date));
    if (candidate === undefined) continue;
    await lockDoctorDay(tx, { tenantId: caller.tenantId, doctorId: input.doctorId, at: candidate.start });
    const fresh = await loadWeekInput(tx, input.doctorId, date, date, context.timezone);
    const found = firstIn(fresh(date), candidate.start.toISOString().slice(0, 10));
    if (found !== undefined) slot = { start: found.start, end: found.end, date };
  }
  if (slot === undefined) return { booked: false, branchId: input.branchId, searchedUntil: horizonEnd };

  const service = await tx.service.findFirst({ where: { id: input.serviceId }, select: { priceMinor: true } });
  const created = await tx.appointment.create({
    data: injected({
      id: uuidv7(),
      branchId: input.branchId,
      patientId: input.patientId,
      doctorId: input.doctorId,
      serviceId: input.serviceId,
      quotedPriceMinor: service?.priceMinor ?? null,
      scheduledStart: slot.start,
      scheduledEnd: slot.end,
      status: "BOOKED",
      source: "DOCTOR",
      createdBy: caller.actor.userId,
      updatedBy: caller.actor.userId,
    }),
  });

  await tx.appointmentEvent.create({
    data: injected({
      id: uuidv7(),
      appointmentId: created.id,
      eventType: "CREATED",
      fromStatus: null,
      toStatus: "BOOKED",
      toScheduledStart: created.scheduledStart,
      actorUserId: caller.actor.userId,
    }),
  });

  const patient = await tx.patient.findFirst({ where: { id: input.patientId }, select: { fullNameAr: true } });
  await recordNotification(tx, caller.actor.userId, {
    kind: "APPOINTMENT_BOOKED",
    appointmentId: created.id,
    patientId: input.patientId,
    source: "DOCTOR",
    occurredAt: input.now,
    payload: { patientName: patient?.fullNameAr ?? "", start: created.scheduledStart.toISOString() },
  });

  return { booked: true, appointmentId: created.id, branchId: input.branchId, date: slot.date };
}
