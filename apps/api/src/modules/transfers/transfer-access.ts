import type { TransactionClient } from "../../prisma/with-tenant.ts";
import { grantIsActive } from "./domain/transfer-state.ts";

/**
 * Does this doctor hold a live transfer grant over this patient?
 *
 * ## What the grant actually relaxes, and why the first answer was wrong
 *
 * `PHASE-3.md` Q21 originally said a transfer grants "read of that patient's `visits` clinical
 * content authored by the from-doctor". Checked against `clinical.access.ts` on 2026-09-01, that
 * grants **nothing**:
 *
 * - Level 2 (`clinical-history`) is already gated on `!isAnotherDoctorsPatient && PRESENT`, so a
 *   colleague's patient is refused whatever any transfer says; and
 * - the query behind it is `visit.findMany({ where: { patientId } })` — **every visit for the
 *   patient, whoever authored it** — so the moment the patient is present on the receiving doctor's
 *   own queue, that doctor already reads the previous doctor's notes with no transfer at all.
 *
 * A grant that duplicates an existing permission is not a small waste. Its expiry cannot be
 * observed, so the test proving expiry cannot fail, so the guarantee is unfalsifiable — which is
 * this project's worst failure shape wearing a security label.
 *
 * **So the grant relaxes presence, not authorship.** The clinical need it serves is a receiving
 * doctor reading a transferred patient's file *before or between* visits — reviewing what they are
 * taking on. `PRESENT` exists to stop a doctor manufacturing access by having reception book an
 * appointment; a transfer accepted by that doctor is a different and deliberate act, bounded by a
 * window, and every read under it is audited as `READ_SENSITIVE` exactly like any cross-doctor read.
 *
 * This is also what makes the expiry provable at the endpoint that returns clinical content: with
 * the window open the fetch succeeds, and with only the clock moved it is refused.
 */
export async function hasActiveTransferGrant(
  tx: TransactionClient,
  input: { patientId: string; doctorId: string },
  now: Date,
): Promise<boolean> {
  // Candidate rows only -- the deliberately narrow set the index (tenant, to_doctor, patient,
  // status) serves. Expiry is NOT expressible here, because it is not a column: it is
  // `decided_at + window`, compared in the domain. SCHEMA-DECISIONS.md D24.
  const grants = await tx.patientTransfer.findMany({
    where: { patientId: input.patientId, toDoctorId: input.doctorId, status: "ACCEPTED" },
    select: { status: true, decidedAt: true, appointment: { select: { status: true } } },
  });

  return grants.some((grant) =>
    grantIsActive(
      {
        status: grant.status,
        decidedAt: grant.decidedAt,
        appointmentStatus: grant.appointment.status,
      },
      now,
    ),
  );
}
