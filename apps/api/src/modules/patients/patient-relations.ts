// Kinship between patients — Q30. Both directions written and removed as a pair, in one transaction.
// Distinct from D28's household: a household is a shared phone, this is a family.

import { uuidv7 } from "uuidv7";
import type { PatientKinship } from "../../generated/prisma/enums.ts";
import { injected } from "../../prisma/injected.ts";
import { withTenant } from "../../prisma/with-tenant.ts";
import type { CallerContext } from "./patients.service.ts";

export interface RelatedPatient {
  id: string;
  relatedPatientId: string;
  fullNameAr: string;
  phoneE164: string;
  /** Read as: this person is the <relation> of the patient being viewed. */
  relation: PatientKinship;
}

/**
 * The reciprocal, decided from the *other* patient's recorded sex.
 *
 * Mirrors `apps/web/src/domain/kinship.ts`, which the intake form uses to show what will be
 * written. Duplicated across the package boundary rather than shared, because the client cannot
 * import server code and the server must not trust a reciprocal the client supplies — the label
 * stored on the second row is a fact about the record, not a field the caller gets to choose.
 */
function reciprocalOf(relation: PatientKinship, otherGender: string | null): PatientKinship {
  if (relation === "HUSBAND") return "WIFE";
  if (relation === "WIFE") return "HUSBAND";
  if (relation === "SON" || relation === "DAUGHTER") {
    return otherGender === "MALE" ? "FATHER" : otherGender === "FEMALE" ? "MOTHER" : "RELATIVE";
  }
  if (relation === "FATHER" || relation === "MOTHER") {
    return otherGender === "MALE" ? "SON" : otherGender === "FEMALE" ? "DAUGHTER" : "RELATIVE";
  }
  return "RELATIVE";
}

export async function listRelations(
  ctx: CallerContext,
  patientId: string,
): Promise<RelatedPatient[]> {
  return withTenant(ctx.tenantId, ctx.actor, async (tx) => {
    const rows = await tx.patientRelation.findMany({
      where: { patientId },
      select: {
        id: true,
        relation: true,
        relatedPatient: { select: { id: true, fullNameAr: true, phoneE164: true } },
      },
      orderBy: { createdAt: "asc" },
    });
    return rows.map((row) => ({
      id: row.id,
      relatedPatientId: row.relatedPatient.id,
      fullNameAr: row.relatedPatient.fullNameAr,
      phoneE164: row.relatedPatient.phoneE164,
      relation: row.relation,
    }));
  });
}

export type RelationResult =
  | { ok: true }
  | { ok: false; code: "NOT_FOUND" | "SAME_PATIENT" | "ALREADY_LINKED" };

export async function linkPatients(
  ctx: CallerContext,
  patientId: string,
  relatedPatientId: string,
  relation: PatientKinship,
): Promise<RelationResult> {
  if (patientId === relatedPatientId) return { ok: false, code: "SAME_PATIENT" };

  return withTenant(ctx.tenantId, ctx.actor, async (tx) => {
    // Both read under the tenant filter, so a patient in another clinic is simply not found.
    const [subject, other] = await Promise.all([
      tx.patient.findUnique({ where: { id: patientId }, select: { id: true, gender: true } }),
      tx.patient.findUnique({ where: { id: relatedPatientId }, select: { id: true, gender: true } }),
    ]);
    if (subject === null || other === null) return { ok: false as const, code: "NOT_FOUND" as const };

    const existing = await tx.patientRelation.findFirst({
      where: { patientId, relatedPatientId },
      select: { id: true },
    });
    if (existing !== null) return { ok: false as const, code: "ALREADY_LINKED" as const };

    await tx.patientRelation.createMany({
      data: [
        injected({
          id: uuidv7(),
          patientId,
          relatedPatientId,
          relation,
          createdByUserId: ctx.actor.userId,
        }),
        injected({
          id: uuidv7(),
          patientId: relatedPatientId,
          relatedPatientId: patientId,
          relation: reciprocalOf(relation, subject.gender),
          createdByUserId: ctx.actor.userId,
        }),
      ],
    });
    return { ok: true as const };
  });
}

/** Removes both rows. A link that survives in one direction is worse than no link. */
export async function unlinkPatients(
  ctx: CallerContext,
  patientId: string,
  relatedPatientId: string,
): Promise<RelationResult> {
  return withTenant(ctx.tenantId, ctx.actor, async (tx) => {
    const removed = await tx.patientRelation.deleteMany({
      where: {
        OR: [
          { patientId, relatedPatientId },
          { patientId: relatedPatientId, relatedPatientId: patientId },
        ],
      },
    });
    return removed.count === 0
      ? { ok: false as const, code: "NOT_FOUND" as const }
      : { ok: true as const };
  });
}
