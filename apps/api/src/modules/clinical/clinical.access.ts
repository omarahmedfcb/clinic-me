import type { AppointmentStatus } from "../../generated/prisma/client.ts";
import type { RefusalParams } from "../../common/refusals.ts";
import { injectedIdOnly } from "../../prisma/injected.ts";
import type { TransactionClient } from "../../prisma/with-tenant.ts";
import type { CallerContext } from "../appointments/appointments.service.ts";
import { hasActiveTransferGrant } from "../transfers/transfer-access.ts";
import { visitScope, type VisitScopeCaller } from "./visit-scope.ts";

/**
 * Who may read what, and what gets recorded when they do — `PHASE-4.md`.
 *
 * ## Two levels, and why the gate is where it is
 *
 * **Level 1, the clinical summary**, is automatic. It is never behind a button, because a safety
 * signal behind a click is one a busy doctor does not see. Allergies are the case that decides
 * this: an allergy nobody looked at is worth nothing.
 *
 * **Level 2, the full record**, needs the patient to be *with* the doctor — ARRIVED, WAITING or
 * IN_CONSULTATION on that doctor's own queue. "Has an appointment" is too weak a gate because
 * reception creates bookings; a doctor could otherwise read any record by having someone book it.
 * "Is physically here and being seen" cannot be manufactured from a booking screen.
 *
 * **Or an accepted, unexpired transfer** (`SCHEMA-DECISIONS.md` D24). This is the second door into
 * Level 2 and the only one that does not require presence, because the clinical need it serves is a
 * receiving doctor reading the file of a patient they are taking on — before or between visits.
 * It cannot be manufactured either: it takes a request somebody else raised and this doctor
 * accepted, it is bounded by a window computed on every read, and every read under it is audited as
 * `READ_SENSITIVE` like any other cross-doctor read.
 *
 * ## Why this is not a permission-matrix change
 *
 * `visits.readContent` is FULL for DOCTOR and NONE for everyone else, which `PermissionGuard`
 * already enforces at the route. What it cannot decide is whether *this* doctor may read *this*
 * patient — that needs the appointment in hand. `permissions.ts` says so explicitly: telling `own`
 * apart from `full` against a specific resource "belongs to the service/controller once the
 * resource is loaded". This is that check, and it needs no new capability.
 */

/**
 * Q6's grace window, ruled by the founder on 2026-09-09: **24 hours, the completing doctor only.**
 *
 * Completion ends the appointment, so under Q18's rule the doctor who has just finished writing a
 * visit loses access to it — and the "I forgot a sentence" case is exactly the minute after. Q6 named
 * this fix when it was written and flagged itself as the ruling most wanting a sanity check.
 *
 * It relaxes **presence and nothing else**. An amendment is still an amendment: a reason is still
 * required and a `visit_revisions` row is still written. A second doctor is refused inside the
 * window exactly as they are outside it, because the thing being avoided is permanent access
 * accumulated on the strength of having once written a note.
 */
export const AMENDMENT_GRACE_MS = 24 * 60 * 60 * 1000;

/**
 * Pure, and `now` is a parameter: a window is only testable at its own boundary if the boundary can
 * be moved without moving the clock (CLAUDE.md).
 */
export function withinAmendmentGrace(
  callerDoctorId: string | null,
  visit: { doctorId: string; completedAt: Date | null },
  now: Date,
): boolean {
  if (callerDoctorId === null || callerDoctorId !== visit.doctorId) return false;
  if (visit.completedAt === null) return false;
  return now.getTime() - visit.completedAt.getTime() <= AMENDMENT_GRACE_MS;
}

/** The statuses that mean the patient is actually in front of the doctor. */
// PAUSED joined 2026-09-09 (Q34): the patient stepped out for imaging and is still this doctor's,
// so the draft they were mid-way through must not close underneath them.
const PRESENT: readonly AppointmentStatus[] = ["ARRIVED", "WAITING", "IN_CONSULTATION", "PAUSED"];

export type ClinicalRefusal =
  | { code: "NOT_FOUND"; params: RefusalParams }
  | { code: "NO_VISIT_YET"; params: RefusalParams }
  | { code: "NOT_PRESENT"; params: RefusalParams };

export interface AccessContext {
  appointmentId: string;
  patientId: string;
  doctorId: string;
  status: AppointmentStatus;
  /** The doctor row belonging to the caller, when the caller is a doctor at all. */
  callerDoctorId: string | null;
  /** True when this appointment belongs to someone other than the caller. */
  isAnotherDoctorsPatient: boolean;
  /**
   * True when Level 2 may be **read**: present with the caller, a live transfer grant, or — R-B,
   * 2026-09-14 — a patient this doctor has already treated.
   */
  mayReadFullHistory: boolean;
  /**
   * True when Level 2 may be **written**: presence or a live transfer grant, and nothing else.
   *
   * Split from the read flag by R-B, which opens reading to a doctor's own past patients and leaves
   * writing exactly where Q18 left it. One name each, so a call site cannot pick the wrong rule by
   * reaching for the only flag there is.
   */
  mayWriteClinical: boolean;
  /** Which of the three doors opened Level 2. Recorded in the audit row, not used for control flow. */
  fullHistoryVia: "PRESENT" | "TRANSFER_GRANT" | "TREATED" | null;
}

/**
 * Is this patient in front of this doctor **right now**?
 *
 * Asked patient-first rather than appointment-first, and that distinction is the whole of it.
 * `resolveAccess` below answers presence from *the appointment being viewed*, which is correct
 * there because that appointment is the thing the caller is looking at. Anywhere the caller is
 * looking at something else — a past visit, a file attached between visits — the same phrasing
 * silently asks the wrong question: it reads the status of a record from last month instead of
 * asking whether this doctor has the patient with them today.
 *
 * That mistake was made and caught by a test on 2026-09-05, in the first draft of
 * `visits.service.ts`, where a colleague with the patient genuinely in their room was refused
 * because the *visit's* month-old appointment was `COMPLETED`. Extracted here so there is one
 * definition of presence rather than one per caller.
 */
export async function isPresentWithDoctor(
  tx: TransactionClient,
  patientId: string,
  doctorId: string,
): Promise<boolean> {
  const present = await tx.appointment.findFirst({
    where: { patientId, doctorId, status: { in: [...PRESENT] } },
    select: { id: true },
  });
  return present !== null;
}

/**
 * Has this doctor **treated** this patient — a completed visit of their own?
 *
 * R-B's door into Level 2 reads, ruled by the founder 2026-09-14. Narrower than the authored-by-me
 * exception he rejected on 2026-09-05: that one turned "I once wrote a note" into permanent access,
 * this one asks for a visit seen through to the end, and it opens **reading only** — writing stays
 * on presence or a transfer grant, so nothing accumulates that can change a record.
 */
export async function hasTreatedPatient(
  tx: TransactionClient,
  caller: VisitScopeCaller,
  patientId: string,
  doctorId: string,
): Promise<boolean> {
  const treated = await tx.visit.findFirst({
    // `visitScope` is a no-op alongside `status: COMPLETED` and is spread anyway: every reader of
    // `visits` carries it, and a reader that is correct today by accident is the next hole.
    where: { patientId, doctorId, status: "COMPLETED", ...visitScope(caller) },
    select: { id: true },
  });
  return treated !== null;
}

/**
 * The doctor row for **this membership**, or null if this membership is not a doctor.
 *
 * ## Why membership and not user
 *
 * This was `doctorIdForUser`, a `findFirst` on `doctor.membership.userId` with no ordering. That
 * was unambiguous only because `memberships` carried `@@unique([userId, tenantId])` — one
 * membership per person per clinic meant at most one doctor row could match.
 *
 * **That constraint was lifted on 2026-09-06**, so a person can now hold two memberships in one
 * clinic. An unordered `findFirst` across them would return a different row on a different day for
 * no visible reason, and the row it returns decides whether someone may read a patient's clinical
 * record. Flagged when the constraint was analysed and fixed in the same change that lifted it,
 * rather than left as a latent one.
 *
 * Keying on `membershipId` needs no ordering at all: `doctors.membership_id` is `@unique`, so the
 * answer is single by construction. It is also the more correct question — a person acting in a
 * clinic acts *as* a membership, which is what the access token carries and what the audit trail
 * records.
 */
export async function doctorIdForMembership(
  tx: TransactionClient,
  membershipId: string,
): Promise<string | null> {
  const doctor = await tx.doctor.findFirst({
    where: { membershipId },
    select: { id: true },
  });
  return doctor?.id ?? null;
}

/**
 * Loads the appointment and works out what the caller may see.
 *
 * A cross-tenant id returns `NOT_FOUND`, never a refusal that admits the row exists — the tenant
 * extension has already made it indistinguishable from an id that never existed.
 */
export async function resolveAccess(
  tx: TransactionClient,
  caller: CallerContext,
  appointmentId: string,
  /**
   * Passed in, never read from the clock here: the transfer window is compared against it, and a
   * boundary that reads its own clock cannot be tested at the boundary (CLAUDE.md).
   */
  now: Date,
): Promise<{ ok: true; access: AccessContext } | { ok: false; refusal: ClinicalRefusal }> {
  const appointment = await tx.appointment.findFirst({
    where: { id: appointmentId },
    select: { id: true, patientId: true, doctorId: true, status: true },
  });

  if (appointment === null) {
    return {
      ok: false,
      refusal: { code: "NOT_FOUND", params: { resource: "appointment" } },
    };
  }

  const callerDoctorId = await doctorIdForMembership(tx, caller.membershipId);
  const isAnotherDoctorsPatient = callerDoctorId === null || callerDoctorId !== appointment.doctorId;

  const presentWithCaller = !isAnotherDoctorsPatient && PRESENT.includes(appointment.status);

  // Only asked when presence has already failed. Not an optimisation -- it keeps the ordinary
  // consultation path exactly as it was, so the transfer feature cannot change the behaviour of a
  // doctor seeing their own patient.
  const viaGrant =
    !presentWithCaller &&
    callerDoctorId !== null &&
    (await hasActiveTransferGrant(tx, { patientId: appointment.patientId, doctorId: callerDoctorId }, now));

  // R-B's third door, asked last and only when the other two have failed, so neither the ordinary
  // consultation path nor the transfer path changes behaviour. Reads only — see `mayWriteClinical`.
  const treated =
    !presentWithCaller &&
    !viaGrant &&
    callerDoctorId !== null &&
    (await hasTreatedPatient(tx, caller, appointment.patientId, callerDoctorId));

  return {
    ok: true,
    access: {
      appointmentId: appointment.id,
      patientId: appointment.patientId,
      doctorId: appointment.doctorId,
      status: appointment.status,
      callerDoctorId,
      isAnotherDoctorsPatient,
      mayReadFullHistory: presentWithCaller || viaGrant || treated,
      mayWriteClinical: presentWithCaller || viaGrant,
      fullHistoryVia: presentWithCaller
        ? "PRESENT"
        : viaGrant
          ? "TRANSFER_GRANT"
          : treated
            ? "TREATED"
            : null,
    },
  };
}

/**
 * Records a clinical read of **another doctor's** patient — the first real emitter of
 * `AuditAction.READ_SENSITIVE`, which has existed in the enum since Phase 1 with nothing writing it.
 *
 * Only cross-doctor reads are recorded, per the ruling. A doctor reading their own patient during
 * that patient's own visit is the ordinary act the system exists for; recording it would bury the
 * reads that matter under the ones that do not, and an audit trail nobody can read is not one.
 *
 * Written inside the caller's transaction, so a read that is rolled back leaves no claim that it
 * happened. `audit_logs` is append-only by trigger (D5), so this row can never be edited away.
 */
export async function recordSensitiveRead(
  tx: TransactionClient,
  caller: CallerContext,
  /** From the validated JWT. Passed in rather than added to CallerContext, which every service shares. */
  actorRole: string,
  access: AccessContext,
  level: "SUMMARY" | "FULL_HISTORY",
): Promise<void> {
  await tx.auditLog.create({
    // `injectedIdOnly`, and `tenantId` supplied explicitly. Both halves matter, and the previous
    // version of this call had neither.
    //
    // `AuditLog` is registered `"nullable"` in `prisma/tenant-scoped-models.ts`, because a row must
    // be able to outlive its tenant via ON DELETE SET NULL. For those models the extension injects
    // `id` and **nothing else** — `injected.ts` says so in as many words. So the comment that used
    // to sit here ("the extension injects it from the bound context") was describing the behaviour
    // of a *scoped* model, and this is not one.
    //
    // The consequence was not a subtle one. `tenant_id` was never written, `audit_logs` has RLS
    // with `WITH CHECK (tenant_id = <bound tenant>)`, and NULL never equals anything — so every
    // call to this function was refused by Postgres with 42501 and surfaced as a 500. The endpoint
    // that carries it, `GET /appointments/:id/clinical-summary`, is the ordinary case of a doctor
    // opening a colleague's patient, and `SCHEMA-DECISIONS.md` D24 rests on the row this writes.
    //
    // Nothing caught it because nothing asserted the row: the spec section was called "cross-tenant
    // and audit" and tested only the cross-tenant half. It is asserted now.
    data: injectedIdOnly({
      // The bound tenant, which is the same value RLS is about to check the row against. This is
      // not a caller asserting its own tenant -- `withTenant` bound it from the validated JWT, and
      // a mismatch would be refused by the very policy this satisfies.
      tenantId: caller.tenantId,
      actorUserId: caller.actor.userId,
      actorRole,
      action: "READ_SENSITIVE",
      entityType: "patients",
      entityId: access.patientId,
      // previousState is omitted rather than set: a read has no prior state, and Prisma writes
      // SQL NULL for an unset nullable Json column.
      // What was read, and about which appointment — enough to answer "who looked at this
      // patient, when, and under what pretext" without copying clinical content into the log.
      newState: {
        level,
        // Which door opened it. "A doctor read this under a transfer grant" and "a doctor read this
        // because the patient was in front of them" are different events to anyone reading the log.
        via: access.fullHistoryVia,
        appointmentId: access.appointmentId,
        appointmentStatus: access.status,
        appointmentDoctorId: access.doctorId,
        callerDoctorId: access.callerDoctorId,
      },
      ipAddress: caller.actor.ip,
      userAgent: caller.actor.userAgent,
    }),
  });
}

export { PRESENT as PRESENT_STATUSES };
