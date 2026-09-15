import type { TransactionClient } from "../../prisma/with-tenant.ts";
import type { DayPlanInput } from "./domain/types.ts";

/**
 * The fetch layer: turning a doctor, a date and a tenant into the pure engine's input.
 *
 * Split out of `appointments.service.ts` when that file passed 300 lines (CLAUDE.md), and the seam
 * is a real one rather than a convenience: everything here touches the database, everything in
 * `domain/` touches none of it, and the service is the only thing that knows both. Nothing in this
 * file decides anything about availability — it fetches rows and maps them.
 */

export interface SchedulingPolicy {
  slotGranularityMinutes: number;
  bookingLeadMinutesStaff: number;
  bookingLeadMinutesPatient: number;
  bookingHorizonDays: number;
}

/** `YYYY-MM-DD` plus days, as `YYYY-MM-DD`. Calendar arithmetic, no zone involved. */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/**
 * The scheduling policy a tenant has set, plus the doctor's and service's rows.
 *
 * Fetched together because every availability question needs all of it, and because the
 * granularity must come from the tenant row rather than from the caller (Q18) — a caller-chosen
 * granularity of 1 turns this endpoint into an oracle enumerating a doctor's day minute by minute.
 */
export async function loadContext(
  tx: TransactionClient,
  tenantId: string,
  doctorId: string,
  serviceId: string,
): Promise<
  | { ok: true; tenant: SchedulingPolicy; timezone: string; durationMinutes: number; bufferMinutes: number }
  | { ok: false; reason: "UNKNOWN_DOCTOR" | "UNKNOWN_SERVICE" }
> {
  // isActive filtering happens here, not in the engine (Q28): the engine documents that it assumes
  // active inputs, and one place deciding it means two callers cannot decide differently.
  const doctor = await tx.doctor.findFirst({ where: { id: doctorId, isActive: true } });
  if (doctor === null) return { ok: false, reason: "UNKNOWN_DOCTOR" };

  const service = await tx.service.findFirst({ where: { id: serviceId, isActive: true } });
  if (service === null) return { ok: false, reason: "UNKNOWN_SERVICE" };

  // findUnique BY ID, never findMany. `tenants` is the one table here that neither layer of
  // tenant isolation touches: the scoping extension classifies Tenant as "none" (it has no
  // tenant_id column -- it *is* the tenant), and it carries no RLS policy, so an unfiltered read
  // returns every clinic in the database. The only thing scoping this row is the `id` below, and
  // that id comes from the validated JWT (CLAUDE.md) and from nowhere else.
  //
  // This was found the honest way: a `findMany` here returned 173 rows in the test database.
  // Taking `[0]` would have silently applied a stranger's slot granularity, lead times and
  // no-show grace period to this clinic -- a cross-tenant read that no test would have noticed,
  // because the numbers would still have looked like numbers.
  const tenant = await tx.tenant.findUnique({
    where: { id: tenantId },
    select: {
      timezone: true,
      slotGranularityMinutes: true,
      bookingLeadMinutesStaff: true,
      bookingLeadMinutesPatient: true,
      bookingHorizonDays: true,
    },
  });
  if (tenant === null) {
    throw new Error(
      `No tenant row for ${tenantId}. The id came from a validated JWT, so this means the tenant ` +
        "was deleted mid-session rather than that a caller supplied a bad value.",
    );
  }

  return {
    ok: true,
    tenant,
    timezone: tenant.timezone,
    durationMinutes: service.durationMinutes,
    bufferMinutes: service.bufferMinutes,
  };
}

/**
 * Fetch the schedule rows the engine needs for one day.
 *
 * Templates and exceptions are for `date` alone — under Q8b a session belongs to the day it began
 * on, so there is nothing the previous day's templates could contribute.
 *
 * **Appointments are different** (Q17). One booked in last night's post-midnight tail occupies
 * real time falling on today, so occupancy is fetched by range overlap across the surrounding
 * days rather than by `scheduled_start` landing on `date`. The range is deliberately generous:
 * it costs one index scan and the alternative is a class of bug that only appears on night
 * clinics.
 */
export async function loadDayInput(
  tx: TransactionClient,
  doctorId: string,
  date: string,
  timezone: string,
): Promise<DayPlanInput> {
  const [templates, exceptions] = await Promise.all([
    tx.scheduleTemplate.findMany({ where: { doctorId } }),
    tx.scheduleException.findMany({
      where: {
        date: { gte: new Date(`${addDays(date, -1)}T00:00:00Z`), lte: new Date(`${addDays(date, 1)}T00:00:00Z`) },
        OR: [{ doctorId }, { doctorId: null }],
      },
    }),
  ]);

  const breaks = await tx.scheduleBreak.findMany({
    where: { scheduleTemplateId: { in: templates.map((t) => t.id) } },
  });

  const appointments = await tx.appointment.findMany({
    where: {
      doctorId,
      scheduledStart: { lt: new Date(`${addDays(date, 2)}T00:00:00Z`) },
      scheduledEnd: { gt: new Date(`${addDays(date, -1)}T00:00:00Z`) },
    },
    include: { service: { select: { bufferMinutes: true } } },
  });

  const wall = (time: Date): string => time.toISOString().slice(11, 16);
  const day = (value: Date): string => value.toISOString().slice(0, 10);

  return {
    timezone,
    date,
    doctorId,
    templates: templates.map((t) => ({
      id: t.id,
      doctorId: t.doctorId,
      weekday: t.weekday,
      startTime: wall(t.startTime),
      endTime: wall(t.endTime),
      validFrom: day(t.validFrom),
      validTo: t.validTo === null ? null : day(t.validTo),
    })),
    breaks: breaks.map((b) => ({
      id: b.id,
      scheduleTemplateId: b.scheduleTemplateId,
      startTime: wall(b.startTime),
      endTime: wall(b.endTime),
    })),
    exceptions: exceptions.map((e) => ({
      id: e.id,
      doctorId: e.doctorId,
      date: day(e.date),
      type: e.type,
      startTime: e.startTime === null ? null : wall(e.startTime),
      endTime: e.endTime === null ? null : wall(e.endTime),
    })),
    existingAppointments: appointments.map((a) => ({
      id: a.id,
      doctorId: a.doctorId,
      scheduledStart: a.scheduledStart,
      scheduledEnd: a.scheduledEnd,
      status: a.status,
      allowOverlap: a.allowOverlap,
      serviceBufferMinutes: a.service.bufferMinutes,
    })),
  };
}


/**
 * One fetch for a whole range of days — the weekly grid's input.
 *
 * **This is why a range endpoint exists rather than seven day requests.** The costly part of
 * answering "what does this day look like" is the fetching, and it is almost identical for one day
 * and for seven: the same templates, the same breaks, the same exceptions, and one appointment
 * query over a wider window. `planDay()` is pure, so once those rows are in hand each extra day is
 * a function call over data already in memory.
 *
 * The other half of the reason is consistency. Seven separate requests are seven separate
 * snapshots, and an appointment booked between the third and the fourth makes the week disagree
 * with itself on screen — a bug that only appears on a busy morning and cannot be reproduced.
 *
 * Returns a builder rather than the days themselves, so the caller decides which dates to render
 * and this file stays a fetch layer that decides nothing.
 */
export async function loadWeekInput(
  tx: TransactionClient,
  doctorId: string,
  from: string,
  to: string,
  timezone: string,
): Promise<(date: string) => DayPlanInput> {
  const [templates, exceptions] = await Promise.all([
    tx.scheduleTemplate.findMany({ where: { doctorId } }),
    tx.scheduleException.findMany({
      where: {
        date: {
          gte: new Date(`${addDays(from, -1)}T00:00:00Z`),
          lte: new Date(`${addDays(to, 1)}T00:00:00Z`),
        },
        OR: [{ doctorId }, { doctorId: null }],
      },
    }),
  ]);

  const breaks = await tx.scheduleBreak.findMany({
    where: { scheduleTemplateId: { in: templates.map((t) => t.id) } },
  });

  // Range overlap, widened a day either side, for the reason Q17 gives: an appointment booked in
  // last night's post-midnight tail occupies real time that falls inside this window.
  const appointments = await tx.appointment.findMany({
    where: {
      doctorId,
      scheduledStart: { lt: new Date(`${addDays(to, 2)}T00:00:00Z`) },
      scheduledEnd: { gt: new Date(`${addDays(from, -1)}T00:00:00Z`) },
    },
    include: { service: { select: { bufferMinutes: true } } },
  });

  const wall = (time: Date): string => time.toISOString().slice(11, 16);
  const day = (value: Date): string => value.toISOString().slice(0, 10);

  const mappedTemplates = templates.map((t) => ({
    id: t.id,
    doctorId: t.doctorId,
    weekday: t.weekday,
    startTime: wall(t.startTime),
    endTime: wall(t.endTime),
    validFrom: day(t.validFrom),
    validTo: t.validTo === null ? null : day(t.validTo),
  }));
  const mappedBreaks = breaks.map((b) => ({
    id: b.id,
    scheduleTemplateId: b.scheduleTemplateId,
    startTime: wall(b.startTime),
    endTime: wall(b.endTime),
  }));
  const mappedExceptions = exceptions.map((e) => ({
    id: e.id,
    doctorId: e.doctorId,
    date: day(e.date),
    type: e.type,
    startTime: e.startTime === null ? null : wall(e.startTime),
    endTime: e.endTime === null ? null : wall(e.endTime),
  }));
  const mappedAppointments = appointments.map((a) => ({
    id: a.id,
    doctorId: a.doctorId,
    scheduledStart: a.scheduledStart,
    scheduledEnd: a.scheduledEnd,
    status: a.status,
    allowOverlap: a.allowOverlap,
    serviceBufferMinutes: a.service.bufferMinutes,
  }));

  return (date: string) => ({
    timezone,
    date,
    doctorId,
    templates: mappedTemplates,
    breaks: mappedBreaks,
    exceptions: mappedExceptions,
    existingAppointments: mappedAppointments,
  });
}
