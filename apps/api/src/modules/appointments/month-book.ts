// «المواعيد» — the appointment book's month view. Phase 5 PR 13.
// Counts per day per doctor, and nothing else: opening a day is what fetches its bookings.

import { Prisma } from "../../generated/prisma/client.ts";
import { LIVE_STATUSES, TERMINAL_STATUSES } from "./domain/transition.ts";
import { instantsForLocal } from "./domain/zoned-time.ts";
import { isPinnedToOwnDoctor, resolveReadableDoctorId } from "../../common/doctor-scope.ts";
import { withTenant } from "../../prisma/with-tenant.ts";
import type { CallerContext } from "./appointments.service.ts";

export interface MonthDay {
  /** `YYYY-MM-DD` in the clinic's timezone — never the server's. */
  date: string;
  /** Still standing. The primary number on the square. */
  total: number;
  /** Completed, cancelled and no-show, counted together and shown muted behind the live count. */
  finished: number;
  byDoctor: { doctorId: string; doctorName: string; count: number }[];
}

export interface MonthBook {
  month: string;
  days: MonthDay[];
  /** The doctors this caller may filter by. One entry for a doctor, who sees only their own. */
  doctors: { id: string; name: string }[];
  /** True when the caller is pinned to themselves: the screen offers no booking and no move. */
  readOnly: boolean;
}

export type MonthResult =
  | { ok: true; value: MonthBook }
  | { ok: false; code: "NOT_FOUND"; params: { resource: "doctor" } };

/** `YYYY-MM` to the first day of that month and of the next one, as calendar days. */
function monthBounds(month: string): { from: string; to: string } {
  const [year, index] = month.split("-").map(Number) as [number, number];
  const nextYear = index === 12 ? year + 1 : year;
  const nextIndex = index === 12 ? 1 : index + 1;
  const pad = (value: number): string => String(value).padStart(2, "0");
  return { from: `${year}-${pad(index)}-01`, to: `${nextYear}-${pad(nextIndex)}-01` };
}

/**
 * How many bookings each doctor has on each day of a month.
 *
 * **Bucketed by the clinic's own calendar day, in SQL.** `scheduled_start` is an instant, and a
 * clinic in Cairo has appointments at 22:00 local that are the next day in UTC. Grouping in
 * JavaScript would need every row fetched to be re-bucketed; grouping by `AT TIME ZONE` lets
 * Postgres return one row per day per doctor, which is the shape the screen draws.
 *
 * **Two counts per day, never summed.** `total` is what is still standing — `LIVE_STATUSES`, the
 * same set the doctors screen uses — because a day showing three when two were cancelled sends
 * reception looking for patients who are not coming. `finished` is the terminal half, counted so a
 * past month is readable rather than blank: the seed's June, July and August hold 1267 appointments
 * between them and every one of them is done, which rendered as three empty months.
 */
export async function describeMonth(
  caller: CallerContext,
  query: { month: string; doctorId?: string },
  _now: Date,
): Promise<MonthResult> {
  return withTenant(caller.tenantId, caller.actor, async (tx) => {
    // A doctor is pinned to themselves; anyone else may filter or see everyone.
    const pinned = isPinnedToOwnDoctor(caller);
    // Three answers, and they are not two: `undefined` is "no filter, show every doctor", `null` is
    // "there is nothing this caller may read", and a string is one doctor. Collapsing the first two
    // filtered the query on `undefined` and returned an empty month for reception — caught by the
    // month-counts test, which is the only reason it was not shipped as "the calendar is empty".
    const resolved = await resolveReadableDoctorId(tx, caller, query.doctorId);
    if (query.doctorId !== undefined && resolved === null) {
      return { ok: false as const, code: "NOT_FOUND" as const, params: { resource: "doctor" as const } };
    }
    if (pinned && resolved === null) {
      // A DOCTOR membership whose doctor row is gone. Answer as though the month is empty rather
      // than falling back to "every doctor", which is how one reads a colleague's book.
      return {
        ok: true as const,
        value: { month: query.month, days: [], doctors: [], readOnly: true },
      };
    }

    const tenant = await tx.tenant.findFirstOrThrow({ select: { timezone: true } });
    const { from, to } = monthBounds(query.month);

    // `Prisma.sql` rather than string building: the one optional clause is composed as a fragment
    // with its own bind parameter, so nothing here is ever concatenated from a value.
    const doctorId = resolved ?? null;
    const onlyOneDoctor =
      doctorId === null ? Prisma.empty : Prisma.sql`AND a.doctor_id = ${doctorId}::uuid`;

    // One pass, two conditional aggregates: a second query for the finished half could disagree with
    // the first about which day a 22:00 appointment belongs to.
    const rows = await tx.$queryRaw<
      { day: Date; doctor_id: string; live: number; finished: number }[]
    >(Prisma.sql`
      SELECT (a.scheduled_start AT TIME ZONE ${tenant.timezone})::date AS day,
             a.doctor_id,
             COUNT(*) FILTER (
               WHERE a.status = ANY(${[...LIVE_STATUSES]}::"AppointmentStatus"[])
             )::int AS live,
             COUNT(*) FILTER (
               WHERE a.status = ANY(${[...TERMINAL_STATUSES]}::"AppointmentStatus"[])
             )::int AS finished
        FROM appointments a
       WHERE (a.scheduled_start AT TIME ZONE ${tenant.timezone})::date >= ${from}::date
         AND (a.scheduled_start AT TIME ZONE ${tenant.timezone})::date < ${to}::date
         ${onlyOneDoctor}
       GROUP BY 1, 2
       ORDER BY 1
    `);

    const doctors = await tx.doctor.findMany({
      where: doctorId === null ? {} : { id: doctorId },
      select: { id: true, printedName: true, membership: { select: { user: { select: { fullName: true } } } } },
      orderBy: { createdAt: "asc" },
    });
    const nameOf = new Map(
      doctors.map((doctor) => [doctor.id, doctor.printedName ?? doctor.membership.user.fullName]),
    );

    const byDate = new Map<string, MonthDay>();
    for (const row of rows) {
      // `::date` comes back as a Date at UTC midnight; the calendar day is its whole content.
      const date = row.day.toISOString().slice(0, 10);
      const day = byDate.get(date) ?? { date, total: 0, finished: 0, byDoctor: [] };
      day.total += row.live;
      day.finished += row.finished;
      // Per-doctor rows carry the live count only: a doctor listed with a zero beside their name on
      // a day they have nothing standing is noise on a square that has to read at a glance.
      if (row.live > 0) {
        day.byDoctor.push({
          doctorId: row.doctor_id,
          doctorName: nameOf.get(row.doctor_id) ?? "",
          count: row.live,
        });
      }
      byDate.set(date, day);
    }

    return {
      ok: true as const,
      value: {
        month: query.month,
        days: [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date)),
        doctors: [...nameOf].map(([id, name]) => ({ id, name })),
        readOnly: pinned,
      },
    };
  });
}

export interface DayBooking {
  appointmentId: string;
  patientName: string;
  doctorId: string;
  doctorName: string;
  serviceId: string;
  serviceName: string;
  startsAt: string;
  status: string;
}

/**
 * One day's bookings, for the panel the month opens.
 *
 * A read of its own rather than the day view's `describeDay`: that one is a pure timeline of
 * working hours, busy blocks and gaps, and it carries no patient name because it does not need
 * one. This is a list a receptionist reads, so it joins the names once rather than leaving the
 * screen to fetch each appointment in turn.
 *
 * **Every status, not just the live ones.** The month square now carries a finished count, so a past
 * day that reads 27 has to open onto those 27 rather than onto "nothing booked" — the panel and the
 * number above it would otherwise contradict each other. Each row carries its status, and the screen
 * decides what may be done to it.
 *
 * Scoped exactly like the month — a doctor sees their own day, and a colleague's id is not found.
 */
export async function listDayBookings(
  caller: CallerContext,
  query: { date: string; doctorId?: string },
): Promise<{ ok: true; value: DayBooking[] } | { ok: false; code: "NOT_FOUND"; params: { resource: "doctor" } }> {
  return withTenant(caller.tenantId, caller.actor, async (tx) => {
    const resolved = await resolveReadableDoctorId(tx, caller, query.doctorId);
    if (query.doctorId !== undefined && resolved === null) {
      return { ok: false as const, code: "NOT_FOUND" as const, params: { resource: "doctor" as const } };
    }
    if (isPinnedToOwnDoctor(caller) && resolved === null) return { ok: true as const, value: [] };
    const doctorId = resolved ?? null;

    const tenant = await tx.tenant.findFirstOrThrow({ select: { timezone: true } });
    const bounds = instantsForLocal(query.date, 0, tenant.timezone)[0] ?? new Date(`${query.date}T00:00:00Z`);
    const end = instantsForLocal(query.date, 24 * 60, tenant.timezone)[0] ?? new Date(bounds.getTime() + 86_400_000);

    const rows = await tx.appointment.findMany({
      where: {
        scheduledStart: { gte: bounds, lt: end },
        ...(doctorId === null ? {} : { doctorId }),
      },
      select: {
        id: true,
        doctorId: true,
        serviceId: true,
        scheduledStart: true,
        status: true,
        patient: { select: { fullNameAr: true } },
        service: { select: { nameAr: true } },
        doctor: {
          select: { printedName: true, membership: { select: { user: { select: { fullName: true } } } } },
        },
      },
      orderBy: { scheduledStart: "asc" },
    });

    return {
      ok: true as const,
      value: rows.map((row) => ({
        appointmentId: row.id,
        patientName: row.patient.fullNameAr,
        doctorId: row.doctorId,
        doctorName: row.doctor.printedName ?? row.doctor.membership.user.fullName,
        serviceId: row.serviceId,
        serviceName: row.service.nameAr,
        startsAt: row.scheduledStart.toISOString(),
        status: row.status,
      })),
    };
  });
}
