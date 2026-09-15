// «مرضاي» — R-B, 2026-09-14. The patients a doctor has actually treated, and search within them.
// The list is the entry point for the read door R-B opens; it never shows a patient never treated.

import { withTenant } from "../../prisma/with-tenant.ts";
import { doctorIdForMembership } from "../clinical/clinical.access.ts";
import { missingIntakeFields } from "./domain/intake-completeness.ts";
import {
  searchPatients,
  type CallerContext,
  type PatientSearchResult,
} from "./patients.service.ts";

/** How many of a doctor's own patients a search may consider. See `listMyPatients`. */
const SEARCH_POOL = 200;

export interface MyPatient extends PatientSearchResult {
  /** The end of the caller's most recent completed visit with this patient. Never null here. */
  lastVisitAt: Date;
  /** Completed visits with the caller. The clinic's total is a different number and not this one. */
  visitCount: number;
}

export interface MyPatientsPage {
  patients: MyPatient[];
  total: number;
}

export type MyPatientsResult =
  | { ok: true; value: MyPatientsPage }
  | { ok: false; code: "NOT_A_DOCTOR" };

interface Row {
  id: string;
  fullNameAr: string;
  fullNameEn: string | null;
  phoneE164: string;
  dateOfBirth: Date | null;
  gender: string | null;
  nationality: string | null;
  status: PatientSearchResult["status"];
  lastVisitAt: Date;
  visitCount: number;
  total: number;
}

/**
 * The doctor's own patients, most recently seen first.
 *
 * **"Treated" means a completed visit of this doctor's own**, which is the same fact
 * `hasTreatedPatient` asks about one patient at a time — the list and the access check must agree,
 * or a patient appears in the tab and refuses to open. A booking is not enough, deliberately:
 * reception creates bookings, so "has an appointment with me" is a relationship anyone at the desk
 * could manufacture, and it is the reason Level 2 was never gated on one.
 *
 * Ordered by last seen, like the clinic's own book, and for the reason D19 gives: under code-point
 * ordering Latin sorts entirely before Arabic, so an alphabetical mixed list reads as a bug.
 *
 * **Search reuses `searchPatients` and intersects.** The clinic has one patient-search
 * implementation — normalisation, transliteration, the trigram floors — and a second one written
 * against a doctor's subset would drift from it in exactly the way D19 warns about. The cost is the
 * pool: search considers the first `SEARCH_POOL` clinic-wide matches and keeps those this doctor has
 * treated, so a very common name in a very large clinic can miss a match this doctor holds. Stated
 * rather than hidden; a doctor's own list is small and the browse path below has no such bound.
 */
export async function listMyPatients(
  ctx: CallerContext,
  membershipId: string,
  options: { search?: string; limit?: number; offset?: number } = {},
): Promise<MyPatientsResult> {
  const limit = options.limit ?? 20;
  const offset = options.offset ?? 0;
  const query = (options.search ?? "").trim();

  const doctorId = await withTenant(ctx.tenantId, ctx.actor, (tx) =>
    doctorIdForMembership(tx, membershipId),
  );
  if (doctorId === null) return { ok: false, code: "NOT_A_DOCTOR" };

  if (query !== "") {
    const matches = await searchPatients(ctx, query, SEARCH_POOL);
    if (matches.length === 0) return { ok: true, value: { patients: [], total: 0 } };
    const mine = await treatedRows(
      ctx,
      doctorId,
      matches.map((patient) => patient.id),
      limit,
      offset,
    );
    return { ok: true, value: mine };
  }

  return { ok: true, value: await treatedRows(ctx, doctorId, null, limit, offset) };
}

/**
 * The rows themselves, optionally narrowed to a set of ids.
 *
 * One statement for the page and the total: two queries can disagree across a visit completing
 * between them, and "showing 20 of 19" is the kind of thing a doctor reports as a bug.
 */
async function treatedRows(
  ctx: CallerContext,
  doctorId: string,
  onlyIds: string[] | null,
  limit: number,
  offset: number,
): Promise<MyPatientsPage> {
  return withTenant(ctx.tenantId, ctx.actor, async (tx) => {
    const rows = await tx.$queryRaw<Row[]>`
      WITH mine AS (
        SELECT v.patient_id,
               max(coalesce(v.completed_at, v.created_at)) AS last_visit_at,
               count(*)::int                               AS visit_count
          FROM visits v
         WHERE v.tenant_id = ${ctx.tenantId}::uuid
           AND v.doctor_id = ${doctorId}::uuid
           AND v.status = 'COMPLETED'
         GROUP BY v.patient_id
      )
      SELECT p.id,
             p.full_name_ar  AS "fullNameAr",
             p.full_name_en  AS "fullNameEn",
             p.phone_e164    AS "phoneE164",
             p.date_of_birth AS "dateOfBirth",
             p.gender,
             p.nationality,
             p.status,
             mine.last_visit_at AS "lastVisitAt",
             mine.visit_count   AS "visitCount",
             count(*) OVER ()::int AS total
        FROM mine
        JOIN patients p ON p.id = mine.patient_id AND p.tenant_id = ${ctx.tenantId}::uuid
       WHERE p.status <> 'MERGED'
         AND (${onlyIds === null}::boolean OR p.id = ANY(${onlyIds ?? []}::uuid[]))
       ORDER BY mine.last_visit_at DESC, p.id DESC
       LIMIT ${limit} OFFSET ${offset}`;

    return {
      patients: rows.map(({ total: _total, gender, nationality, ...row }) => ({
        ...row,
        missingIntakeFields: missingIntakeFields({ ...row, gender, nationality }),
      })),
      total: rows[0]?.total ?? 0,
    };
  });
}
