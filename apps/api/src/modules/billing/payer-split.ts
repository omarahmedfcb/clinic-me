// The payer split — Phase 5 PR 7, `PHASE-5-DESIGN.md` §4.2. Manual, and deliberately so.

import type { RefusalParams } from "../../common/refusals.ts";
import { withTenant, type TransactionClient } from "../../prisma/with-tenant.ts";
import { doctorIdForMembership } from "../clinical/clinical.access.ts";
import type { DeskCaller } from "./desk.ts";

/** A doctor reads and sets the split only on their own patients' charges (R2). */
async function ownCharge(tx: TransactionClient, caller: DeskCaller, chargeId: string) {
  if (caller.role !== "DOCTOR") return { id: chargeId };
  const doctorId = await doctorIdForMembership(tx, caller.membershipId);
  return { id: chargeId, visit: { doctorId: doctorId ?? "" } };
}

export type SplitRefusalReason = "NOT_FOUND" | "SPLIT_EXCEEDS_CHARGE" | "ALREADY_SETTLED";

export type SplitResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: SplitRefusalReason; params: RefusalParams };

export interface ChargeSplit {
  chargeId: string;
  subtotalMinor: number;
  discountMinor: number;
  payerShareMinor: number;
  patientShareMinor: number;
  /** The registry row the patient's policy names, when there is one. */
  payerName: string | null;
}

/**
 * Sets what an insurer or employer is expected to pay on a charge.
 *
 * **Manual, and the blocker is factual rather than preferential.** There is no coverage rate
 * anywhere in this schema — PR 1 shipped the company registry with its two money fields
 * deliberately absent — and real Egyptian corporate and insurer policies vary the rate by service,
 * add annual ceilings and add per-visit co-payments. Automating a split against a rate nobody has
 * entered would be automating a guess, and it would look authoritative on an invoice.
 *
 * The database refuses a payer share larger than what remains after the discount, so the patient's
 * share can never go negative and no screen has to decide what a negative amount due means. This
 * function turns that constraint into a sentence rather than a constraint violation.
 */
export async function setPayerShare(
  caller: DeskCaller,
  chargeId: string,
  payerShareMinor: number,
): Promise<SplitResult<ChargeSplit>> {
  return withTenant(caller.tenantId, caller.actor, async (tx) => {
    const charge = await tx.visitCharge.findFirst({
      where: await ownCharge(tx, caller, chargeId),
      select: {
        id: true,
        status: true,
        subtotalMinor: true,
        discountMinor: true,
        patientId: true,
      },
    });
    // 404 rather than 403 for another clinic's charge: the tenant extension has already made a
    // cross-tenant id indistinguishable from a missing one.
    if (charge === null) {
      return { ok: false as const, code: "NOT_FOUND" as const, params: { resource: "visit" as const } };
    }
    if (charge.status === "VOID") {
      return { ok: false as const, code: "ALREADY_SETTLED" as const, params: {} };
    }

    const remainder = charge.subtotalMinor - charge.discountMinor;
    if (payerShareMinor < 0 || payerShareMinor > remainder) {
      // Checked here as well as by the CHECK constraint, so the desk gets a sentence rather than a
      // constraint violation — the same division `insurance.service.ts` uses for INVALID_WINDOW.
      return {
        ok: false as const,
        code: "SPLIT_EXCEEDS_CHARGE" as const,
        params: { limit: remainder, actual: payerShareMinor },
      };
    }

    await tx.visitCharge.update({
      where: { id: chargeId },
      data: { payerShareMinor },
    });

    return { ok: true as const, value: await readSplit(tx, chargeId, charge.patientId) };
  });
}

export async function getPayerSplit(
  caller: DeskCaller,
  chargeId: string,
): Promise<SplitResult<ChargeSplit>> {
  return withTenant(caller.tenantId, caller.actor, async (tx) => {
    const charge = await tx.visitCharge.findFirst({
      where: await ownCharge(tx, caller, chargeId),
      select: { id: true, patientId: true },
    });
    if (charge === null) {
      return { ok: false as const, code: "NOT_FOUND" as const, params: { resource: "visit" as const } };
    }
    return { ok: true as const, value: await readSplit(tx, chargeId, charge.patientId) };
  });
}

/** Reads the split from the balance view, so the patient's share is never computed here (D7). */
async function readSplit(
  tx: Parameters<Parameters<typeof withTenant>[2]>[0],
  chargeId: string,
  patientId: string,
): Promise<ChargeSplit> {
  const rows = await tx.$queryRaw<
    {
      subtotal_minor: number;
      discount_minor: number;
      payer_share_minor: number;
      patient_share_minor: number;
    }[]
  >`SELECT subtotal_minor, discount_minor, payer_share_minor, patient_share_minor
      FROM visit_charge_balances WHERE charge_id = ${chargeId}::uuid`;
  const row = rows[0];

  // The insurer the patient's own policy names, for the screen to show beside the amount. Read
  // through the registry rather than the free-text `insurer_name`, so a clinic that has filled its
  // registry sees one spelling. Null when there is no policy, which is most patients.
  const cover = await tx.patientInsurance.findFirst({
    where: { patientId },
    select: { policy: { select: { company: { select: { name: true } }, insurerName: true } } },
    orderBy: { isPrimary: "desc" },
  });

  return {
    chargeId,
    subtotalMinor: row?.subtotal_minor ?? 0,
    discountMinor: row?.discount_minor ?? 0,
    payerShareMinor: row?.payer_share_minor ?? 0,
    patientShareMinor: row?.patient_share_minor ?? 0,
    payerName: cover?.policy.company?.name ?? cover?.policy.insurerName ?? null,
  };
}
