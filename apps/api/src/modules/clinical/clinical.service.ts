import { withTenant } from "../../prisma/with-tenant.ts";
import { calendarDayIn } from "../appointments/domain/zoned-time.ts";
import { standingOf } from "../insurance/domain/policy-window.ts";
import type { QueueCoverage } from "../queue/queue.types.ts";
import type { CallerContext } from "../appointments/appointments.service.ts";
import {
  recordSensitiveRead,
  resolveAccess,
  type ClinicalRefusal,
} from "./clinical.access.ts";
import { visitScope } from "./visit-scope.ts";
import { missingIntakeFields } from "../patients/domain/intake-completeness.ts";
import type { ClinicalHistory, ClinicalSummary } from "./clinical.types.ts";

/**
 * The doctor's two clinical reads — `PHASE-4.md`.
 *
 * These are **separate functions behind separate endpoints**, not one response filtered by role.
 * `CLAUDE.md` requires that: clinical content is enforced "by separate endpoints and separate DTOs
 * — never by filtering fields out of one response", because a filter is one forgotten branch away
 * from sending a diagnosis to reception, and nothing about the response shape would say so.
 *
 * Reception never calls either. `visits.readContent` is NONE for every role but DOCTOR, so the
 * guard refuses at the route before any of this runs.
 */

type Result<T> = { ok: true; value: T } | { ok: false; refusal: ClinicalRefusal };

/**
 * Level 1 — the safety summary. Automatic, never gated behind a click.
 *
 * ## Chronic medication is derived, and shown as derived
 *
 * There is no stored medication list. This reads the most recent prescription's items and carries
 * `sourcePrescriptionId` and `issuedAt` with them, so the interface can show provenance and age
 * rather than presenting them as facts somebody entered. A mirrored field would go stale the first
 * time a doctor changed a dose in a prescription without updating the copy, and a stale medication
 * list in a safety summary is worse than an empty one because it will be trusted.
 *
 * **Until Phase 4's prescriptions ship, this is empty for every patient.** That is correct and it
 * looks broken, which is why the interface says "no prescriptions recorded" rather than rendering
 * nothing.
 *
 * ## An empty allergy list is not an answer
 *
 * `allergiesReviewedAt` is returned alongside, because an empty list means either "no known
 * allergies" or "nobody asked", and only the first is reassurance.
 */
export async function getClinicalSummary(
  caller: CallerContext,
  actorRole: string,
  appointmentId: string,
  /** The instant the transfer window is compared against. Injected so the boundary is testable. */
  now: Date = new Date(),
): Promise<Result<ClinicalSummary>> {
  return withTenant(caller.tenantId, caller.actor, async (tx) => {
    const resolved = await resolveAccess(tx, caller, appointmentId, now);
    if (!resolved.ok) return { ok: false as const, refusal: resolved.refusal };
    const { access } = resolved;

    const patient = await tx.patient.findFirst({
      where: { id: access.patientId },
      select: {
        id: true,
        fileNumber: true,
        fullNameAr: true,
        fullNameEn: true,
        // Q45: the printed sheet is English, and a patient with no English name prints the
        // transliteration search already maintains (D19) rather than Arabic on an English form.
        nameSearchLatin: true,
        dateOfBirth: true,
        gender: true,
        phoneE164: true,
        // Only so the header can say the file is incomplete. Never rendered to the doctor as a
        // field: the review of #99 gives them date of birth, sex and phone and nothing else.
        nationality: true,
        allergiesReviewedAt: true,
      },
    });
    if (patient === null) {
      return {
        ok: false as const,
        refusal: { code: "NOT_FOUND" as const, params: { resource: "patient" } as const },
      };
    }

    const [allergies, plans, visits, latestPrescription, completedVisits, policies, tenant] =
      await Promise.all([
      tx.patientAllergy.findMany({
        where: { patientId: access.patientId, status: "ACTIVE" },
        select: { id: true, substance: true, reaction: true, severity: true, recordedAt: true },
        orderBy: { severity: "desc" },
      }),
      tx.treatmentPlan.findMany({
        where: { patientId: access.patientId, status: "ACTIVE" },
        select: { id: true, title: true, totalSessions: true, completedSessions: true, startedAt: true },
        orderBy: { startedAt: "desc" },
      }),
      // Dates and doctor only. The content of a visit is Level 2.
      tx.visit.findMany({
        where: { patientId: access.patientId, ...visitScope(caller) },
        select: { id: true, appointmentId: true, doctorId: true, completedAt: true, createdAt: true },
        orderBy: { createdAt: "desc" },
        take: 10,
      }),
      tx.prescription.findFirst({
        where: { patientId: access.patientId },
        orderBy: { issuedAt: "desc" },
        select: { id: true, issuedAt: true, items: { select: { medicationName: true, dose: true, frequency: true } } },
      }),
      // Counted, not `recentVisits.length`: that list is capped at ten, and a header saying "10
      // visits" about a patient with forty would be a confident wrong number (Q21).
      tx.visit.count({ where: { patientId: access.patientId, status: "COMPLETED", ...visitScope(caller) } }),
      tx.patientInsurance.findMany({
        where: { patientId: access.patientId },
        select: { policy: { select: { insurerName: true, validFrom: true, validTo: true } } },
      }),
      tx.tenant.findUniqueOrThrow({ where: { id: caller.tenantId }, select: { timezone: true } }),
    ]);

    // The same three-state badge the queue row carries, decided by the same `standingOf` — "your
    // cover ended" and "you have no cover with us" are different conversations (PHASE-3.md Q18).
    const onDay = calendarDayIn(now, tenant.timezone);
    let coverage: QueueCoverage = { standing: "NONE" };
    for (const row of policies) {
      const standing = standingOf(
        {
          validFrom: row.policy.validFrom.toISOString().slice(0, 10),
          validTo: row.policy.validTo === null ? null : row.policy.validTo.toISOString().slice(0, 10),
        },
        onDay,
      );
      if (standing === "ACTIVE") {
        coverage = { standing: "COVERED", insurerName: row.policy.insurerName };
        break;
      }
      if (standing === "LAPSED" && coverage.standing === "NONE") {
        coverage = { standing: "LAPSED", insurerName: row.policy.insurerName };
      }
    }

    if (access.isAnotherDoctorsPatient) {
      await recordSensitiveRead(tx, caller, actorRole, access, "SUMMARY");
    }

    return {
      ok: true as const,
      value: {
        patientId: patient.id,
        // Q45 printed a reference derived from the UUID because no file number existed. It does now.
        fileNumber: patient.fileNumber,
        fullNameAr: patient.fullNameAr,
        fullNameEn: patient.fullNameEn,
        nameSearchLatin: patient.nameSearchLatin,
        dateOfBirth: patient.dateOfBirth,
        gender: patient.gender,
        phoneE164: patient.phoneE164,
        // Derived on read like everywhere else (D26), so completing the record clears the badge.
        missingIntakeFields: missingIntakeFields(patient),
        allergies,
        allergiesReviewedAt: patient.allergiesReviewedAt,
        currentMedication:
          latestPrescription === null
            ? []
            : latestPrescription.items.map((item) => ({
                ...item,
                sourcePrescriptionId: latestPrescription.id,
                issuedAt: latestPrescription.issuedAt,
              })),
        activeTreatmentPlans: plans,
        recentVisits: visits.map((v) => ({
          id: v.id,
          appointmentId: v.appointmentId,
          doctorId: v.doctorId,
          at: v.completedAt ?? v.createdAt,
        })),
        coverage,
        visitCount: completedVisits,
        lastVisitAt: visits[0] === undefined ? null : (visits[0].completedAt ?? visits[0].createdAt),
        mayReadFullHistory: access.mayReadFullHistory,
        appointmentStatus: access.status,
      },
    };
  });
}

/**
 * Level 2 — the full record. Only while the patient is with this doctor.
 *
 * Refused with `NOT_PRESENT` rather than `NOT_FOUND`: the caller is a doctor who legitimately sees
 * this appointment on a screen, so hiding its existence would be theatre. What is withheld is the
 * content, and the reason is one the interface can explain — "available once the patient is with
 * you" is actionable; a 404 on a row they can see is not.
 *
 * **Read-only.** There is deliberately no amend path here; viewing another doctor's record never
 * grants the ability to change it.
 */
export async function getClinicalHistory(
  caller: CallerContext,
  actorRole: string,
  appointmentId: string,
  /** The instant the transfer window is compared against. Injected so the boundary is testable. */
  now: Date = new Date(),
): Promise<Result<ClinicalHistory>> {
  return withTenant(caller.tenantId, caller.actor, async (tx) => {
    const resolved = await resolveAccess(tx, caller, appointmentId, now);
    if (!resolved.ok) return { ok: false as const, refusal: resolved.refusal };
    const { access } = resolved;

    if (!access.mayReadFullHistory) {
      return {
        ok: false as const,
        refusal: {
          code: "NOT_PRESENT" as const,
          params: {},
        },
      };
    }

    const [visits, prescriptions] = await Promise.all([
      tx.visit.findMany({
        where: { patientId: access.patientId, ...visitScope(caller) },
        select: {
          id: true,
          appointmentId: true,
          doctorId: true,
          completedAt: true,
          createdAt: true,
          complaint: true,
          medicalHistory: true,
          examination: true,
          diagnosis: true,
          treatmentPlan: true,
          doctorNotes: true,
          followUpDate: true,
        },
        orderBy: { createdAt: "desc" },
        take: 20,
      }),
      tx.prescription.findMany({
        where: { patientId: access.patientId },
        select: {
          id: true,
          issuedAt: true,
          notes: true,
          items: { select: { medicationName: true, dose: true, frequency: true, duration: true, instructions: true } },
        },
        orderBy: { issuedAt: "desc" },
        take: 20,
      }),
    ]);

    // Own patient by definition here (the gate requires it), so no READ_SENSITIVE row is written.
    return { ok: true as const, value: { visits, prescriptions } };
  });
}
