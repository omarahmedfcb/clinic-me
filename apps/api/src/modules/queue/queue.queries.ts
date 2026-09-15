import { withTenant, type TransactionClient } from "../../prisma/with-tenant.ts";
import type { CallerContext } from "../appointments/appointments.service.ts";
import { resolveReadableDoctorId } from "../../common/doctor-scope.ts";
import { graceReferenceInstant, isNoShowCandidate } from "./domain/no-show.ts";
import { orderQueue, type QueueOrdering } from "./domain/ordering.ts";
import { clinicDayBounds } from "./queue.day.ts";
import { doctorFreeAt } from "./queue.readiness.ts";
import { standingOf } from "../insurance/domain/policy-window.ts";
import { appointmentDoctorScope } from "../clinical/visit-scope.ts";
import {
  ON_QUEUE,
  type NoShowCandidate,
  type QueueCoverage,
  type QueueEntry,
  type QueueQuery,
} from "./queue.types.ts";

/**
 * The queue's reads. Mutations live in `queue.moves.ts`.
 *
 * Nothing in this file writes, and in `pendingNoShows()`'s case that is a ruling rather than a
 * property of the current implementation — see the note on it.
 */

interface PolicyRow {
  patientId: string;
  policy: { insurerName: string; validFrom: Date; validTo: Date | null };
}

/**
 * One status per appointment-and-its-own-doctor — Q14.
 *
 * **COMPLETED wins over DRAFT.** Q15 permits several drafts per appointment and exactly one
 * completed visit, and the same doctor can hold both: a draft they abandoned and the visit they
 * finished. "Finished" is the fact reception acts on, so a finished visit is never reported as still
 * in progress.
 */
function visitStatusByAppointment(
  visits: readonly { appointmentId: string; status: "DRAFT" | "COMPLETED" }[],
): Map<string, "DRAFT" | "COMPLETED"> {
  const byAppointment = new Map<string, "DRAFT" | "COMPLETED">();
  for (const visit of visits) {
    // Which doctor's visit this is has already been decided by `appointmentDoctorScope`. Deciding
    // it again here would leave that scope doing nothing while looking like it did.
    if (visit.status === "COMPLETED" || !byAppointment.has(visit.appointmentId)) {
      byAppointment.set(visit.appointmentId, visit.status);
    }
  }
  return byAppointment;
}

/**
 * Folds every policy row for the board into one badge per patient.
 *
 * `onDay` is the **clinic-local** date the queue is already built around (`QueueQuery.date`, Q12),
 * not a fresh reading of the clock and not UTC. That matters at the edges of a day for exactly the
 * reason `getPatientCoverage` takes a timezone: a policy ending on the 31st is live at 01:00 Cairo
 * on the 31st, which is 23:00 UTC on the 30th, and the desk would be told to charge a covered
 * patient. Reusing the day the rest of the screen agrees on also means the badge cannot disagree
 * with the row it sits on.
 *
 * Precedence is deliberate: **a live policy beats a lapsed one.** A patient who renewed is covered,
 * and the expired row is history the profile shows — not a reason to ask them for money.
 *
 * A policy that has not started yet folds into `NONE` rather than `LAPSED`. Both are "do not bill
 * the insurer today", which is the only decision this badge exists to support, and calling
 * next Monday's cover "lapsed" would be an outright lie at the desk. The profile shows it properly.
 */
function coverageByPatient(rows: PolicyRow[], onDay: string): Map<string, QueueCoverage> {
  const byPatient = new Map<string, QueueCoverage>();

  for (const row of rows) {
    const standing = standingOf(
      {
        validFrom: row.policy.validFrom.toISOString().slice(0, 10),
        validTo: row.policy.validTo === null ? null : row.policy.validTo.toISOString().slice(0, 10),
      },
      onDay,
    );
    if (standing === "FUTURE") continue;

    const current = byPatient.get(row.patientId);
    if (standing === "ACTIVE") {
      byPatient.set(row.patientId, { standing: "COVERED", insurerName: row.policy.insurerName });
      continue;
    }
    // LAPSED: recorded only if nothing better has been seen, so a renewal always wins.
    if (current === undefined) {
      byPatient.set(row.patientId, { standing: "LAPSED", insurerName: row.policy.insurerName });
    }
  }

  return byPatient;
}

/** The tenant's zone, and the day's bounds resolved in it. Shared by the two date-based entries. */
async function boundsFor(
  tx: TransactionClient,
  tenantId: string,
  date: string,
): Promise<{ dayStart: Date; dayEnd: Date }> {
  const tenant = await tx.tenant.findUnique({
    where: { id: tenantId },
    select: { timezone: true },
  });
  if (tenant === null) {
    // Unreachable through an authenticated request — the tenant is the one in the caller's token.
    throw new Error(`No tenant ${tenantId} while resolving the queue day.`);
  }
  return clinicDayBounds(tx, date, tenant.timezone);
}

/**
 * The queue for a calendar date, resolving the day's bounds in the tenant's own zone.
 *
 * **This is what an endpoint calls**, rather than the controller computing bounds and passing them
 * in. `CLAUDE.md`'s two-caller rule cuts both ways: if the HTTP layer resolved the day, the AI
 * tool layer would have to resolve it too, and Q12's "the queue and the day view use the same
 * code" would hold for one caller and not the other.
 *
 * `describeQueue()` below keeps taking explicit bounds, because a caller that already knows them —
 * a test pinning an exact window, a future range view — should not have to re-derive them.
 */
export async function describeQueueForDate(
  caller: CallerContext,
  query: { date: string; now: Date; doctorId?: string; ordering?: QueueOrdering },
): Promise<{ date: string; entries: QueueEntry[] }> {
  const scoped = await withTenant(caller.tenantId, caller.actor, async (tx) => ({
    bounds: await boundsFor(tx, caller.tenantId, query.date),
    // The queue screen has no doctor picker to hide -- Q11 groups every doctor on purpose, because
    // reception works the room -- so unlike the day view there was never a UI half to this. A
    // DOCTOR omitting doctorId used to receive the whole clinic's queue, 200.
    doctorId: await resolveReadableDoctorId(tx, caller, query.doctorId),
  }));

  // A colleague's id from a pinned role. An empty queue, not a refusal: the endpoint answers "the
  // whole screen for this day" and the honest answer for a day containing none of your patients is
  // an empty list. `PHASE-3.md`'s "indistinguishable from a nonexistent id" is preserved -- a
  // nonexistent doctor id yields the same empty list.
  if (scoped.doctorId === null) return { date: query.date, entries: [] };

  return describeQueue(caller, { ...query, doctorId: scoped.doctorId, ...scoped.bounds });
}

/** `pendingNoShows()` for a calendar date. Same reasoning as `describeQueueForDate()`. */
export async function pendingNoShowsForDate(
  caller: CallerContext,
  query: { date: string; now: Date },
): Promise<NoShowCandidate[]> {
  const scoped = await withTenant(caller.tenantId, caller.actor, async (tx) => ({
    bounds: await boundsFor(tx, caller.tenantId, query.date),
    // This endpoint takes no `doctorId` at all, which is exactly why it was missed when every
    // reader that *took* one was scoped on 2026-09-01: an audit that asks "which endpoints accept a
    // doctorId" cannot see an endpoint that accepts none and returns every doctor's patients by
    // name. Scoped on the same rule as the queue it sits beside.
    doctorId: await resolveReadableDoctorId(tx, caller, undefined),
  }));

  // A pinned role with no doctors row. No candidates, rather than the clinic's.
  if (scoped.doctorId === null) return [];

  return pendingNoShows(caller, { ...scoped.bounds, now: query.now, doctorId: scoped.doctorId });
}

/**
 * The whole queue screen in one request.
 *
 * One query and one snapshot, for the same reason the week grid is one request rather than seven:
 * several requests are several snapshots, and a queue that disagrees with itself between two of
 * them is a bug that only appears on a busy morning.
 *
 * The day bounds are **passed in**, not computed here with `date_trunc`. Q12: the queue and the
 * day view answer "which day is this appointment on" with the same code, or a patient seen at
 * 00:30 in a Thursday-night clinic vanishes from the screen they are standing in front of.
 */
export async function describeQueue(
  caller: CallerContext,
  query: QueueQuery,
): Promise<{ date: string; entries: QueueEntry[] }> {
  const { rows, coverage, visitStatus } = await withTenant(caller.tenantId, caller.actor, async (tx) => {
    const appointments = await tx.appointment.findMany({
      where: {
        scheduledStart: { gte: query.dayStart, lt: query.dayEnd },
        status: { in: [...ON_QUEUE] },
        ...(query.doctorId === undefined ? {} : { doctorId: query.doctorId }),
      },
      select: {
        id: true,
        patientId: true,
        doctorId: true,
        serviceId: true,
        status: true,
        source: true,
        scheduledStart: true,
        scheduledEnd: true,
        arrivedAt: true,
        waitingStartedAt: true,
        consultationStartedAt: true,
        patient: { select: { fullNameAr: true } },
      },
    });

    // ---- One query for the whole board, not one per row. ----
    //
    // The founder's constraint, and it is a real cost rather than a tidiness point: this screen
    // polls every five seconds (Q1), so a per-row lookup multiplies the board's cost by the number
    // of patients waiting, every five seconds, permanently, to render one label. Every patient on
    // the queue is fetched in a single `IN (...)` against
    // `patient_insurance_patient_idx (tenant_id, patient_id)`.
    //
    // Skipped entirely when the board is empty -- `IN ()` is a query issued to learn nothing.
    const patientIds = [...new Set(appointments.map((row) => row.patientId))];
    const policies =
      patientIds.length === 0
        ? []
        : await tx.patientInsurance.findMany({
            where: { patientId: { in: patientIds } },
            select: {
              patientId: true,
              policy: { select: { insurerName: true, validFrom: true, validTo: true } },
            },
          });

    // The queue's one visit read, batched like the coverage read above and for the same reason:
    // the board polls every five seconds and a per-row lookup would multiply that by the number of
    // patients waiting, permanently, for one label.
    const visits =
      appointments.length === 0
        ? []
        : await tx.visit.findMany({
            where: appointmentDoctorScope(
              appointments.map((row) => ({ appointmentId: row.id, doctorId: row.doctorId })),
            ),
            // Status only. Selecting anything a clinician typed would be a leak, and the DTO
            // allow-list is what stops the next field arriving quietly.
            select: { appointmentId: true, status: true },
          });

    return {
      rows: appointments,
      coverage: coverageByPatient(policies, query.date),
      visitStatus: visitStatusByAppointment(visits),
    };
  });

  const entries: QueueEntry[] = rows.map((r) => ({
    appointmentId: r.id,
    patientId: r.patientId,
    patientName: r.patient?.fullNameAr ?? null,
    coverage: coverage.get(r.patientId) ?? { standing: "NONE" },
    doctorId: r.doctorId,
    serviceId: r.serviceId,
    status: r.status,
    scheduledStart: r.scheduledStart,
    scheduledEnd: r.scheduledEnd,
    arrivedAt: r.arrivedAt,
    waitingStartedAt: r.waitingStartedAt,
    consultationStartedAt: r.consultationStartedAt,
    waitedMs: r.arrivedAt === null ? null : query.now.getTime() - r.arrivedAt.getTime(),
    isWalkIn: r.source === "WALK_IN",
    visitStatus: visitStatus.get(r.id) ?? null,
  }));

  return { date: query.date, entries: orderQueue(entries, query.ordering) };
}

/**
 * Appointments a person should be **asked** about — `PHASE-3.md` Q8.
 *
 * ## This function writes nothing, and that is the ruling, not an omission
 *
 * It is tempting to automate: the rows are right here, the grace has elapsed, marking them is one
 * `update`. **Do not.** `NO_SHOW` is terminal *and* it releases the slot — `constraintOccupies`
 * treats it as free — so an automatic mark can give away the time of a patient who is sitting in
 * the waiting room, with no transition back.
 *
 * That is not a rare case. The doctor runs ninety minutes late, the patient has been there since
 * ten, and the appointment book says their grace expired an hour ago. Q9's readiness instant makes
 * the list far better but it cannot fix this, because no instant can know that someone is in the
 * room. Only a person looking can.
 *
 * The failure is also invisible in testing, because test data never sits in a waiting room.
 *
 * **To whoever later proposes automating this as an efficiency:** what you are buying is a
 * receptionist clicking a button. What you are risking is telling a patient in front of you that
 * the system has recorded them as absent. Those are not comparable.
 */
export async function pendingNoShows(
  caller: CallerContext,
  query: { dayStart: Date; dayEnd: Date; now: Date; doctorId?: string },
): Promise<NoShowCandidate[]> {
  return withTenant(caller.tenantId, caller.actor, async (tx) => {
    const tenant = await tx.tenant.findUnique({
      where: { id: caller.tenantId },
      select: { noShowGraceMinutes: true },
    });
    const graceMinutes = tenant?.noShowGraceMinutes ?? 30;

    // Only ever the two statuses MARK_NO_SHOW is legal from: a patient who checked in cannot
    // later be absent, and the state machine says so. Selecting them here as well keeps the list
    // from offering a person a choice the machine would refuse.
    const rows = await tx.appointment.findMany({
      where: {
        scheduledStart: { gte: query.dayStart, lt: query.dayEnd },
        status: { in: ["BOOKED", "CONFIRMED"] },
        ...(query.doctorId === undefined ? {} : { doctorId: query.doctorId }),
      },
      select: {
        id: true,
        patientId: true,
        doctorId: true,
        scheduledStart: true,
        patient: { select: { fullNameAr: true } },
      },
      orderBy: { scheduledStart: "asc" },
    });

    const freeAtByDoctor = new Map<string, Date | null>();
    const candidates: NoShowCandidate[] = [];

    for (const r of rows) {
      if (!freeAtByDoctor.has(r.doctorId)) {
        freeAtByDoctor.set(r.doctorId, await doctorFreeAt(tx, r.doctorId, query.now));
      }
      const freeAt = freeAtByDoctor.get(r.doctorId) ?? null;
      const input = {
        scheduledStart: r.scheduledStart,
        doctorFreeAt: freeAt,
        graceMinutes,
        now: query.now,
      };
      if (!isNoShowCandidate(input)) continue;

      candidates.push({
        appointmentId: r.id,
        patientId: r.patientId,
        patientName: r.patient?.fullNameAr ?? null,
        doctorId: r.doctorId,
        scheduledStart: r.scheduledStart,
        eligibleSince: new Date(
          graceReferenceInstant(r.scheduledStart, freeAt).getTime() + graceMinutes * 60_000,
        ),
      });
    }

    return candidates;
  });
}
