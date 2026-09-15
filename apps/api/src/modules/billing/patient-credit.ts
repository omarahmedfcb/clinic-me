// Clinic credit — ruling 5 as amended by R-A. A ledger of movements; the balance is a view.
// Credit arises only where refusing the money is impossible; credit settles later charges.

import { randomUUID } from "node:crypto";
import type { AppointmentStatus } from "../../generated/prisma/enums.ts";
import type { RefusalParams } from "../../common/refusals.ts";
import { injected } from "../../prisma/injected.ts";
import { withTenant, type TransactionClient } from "../../prisma/with-tenant.ts";
import type { CallerContext } from "../appointments/appointments.service.ts";

/**
 * Why a credit the system wrote exists. A code, not a sentence: the ledger is read in Arabic, and
 * `reason` also carries a human's own words on a refund — which never look like one of these.
 */
export const CREDIT_ORIGIN = {
  prePaymentAboveBill: "PRE_PAYMENT_ABOVE_BILL",
  appointmentCancelled: "APPOINTMENT_CANCELLED",
  appointmentNotAttended: "APPOINTMENT_NOT_ATTENDED",
} as const;

export type CreditRefusal =
  | "NOT_FOUND"
  | "INSUFFICIENT_CREDIT"
  | "REFUND_REASON_REQUIRED"
  | "AMOUNT_NOT_POSITIVE"
  | "PAYMENT_EXCEEDS_BALANCE";

export type CreditResult<T> = { ok: true; value: T } | { ok: false; code: CreditRefusal; params: RefusalParams };

export interface CreditMovementRow {
  id: string;
  movement: "CREDIT" | "APPLIED" | "REFUNDED";
  amountMinor: number;
  reason: string | null;
  actorName: string;
  /** The receipt this credit came from, when it came from one. */
  receiptNumber: number | null;
  appliedChargeId: string | null;
  at: string;
}

export interface CreditLedger {
  patientId: string;
  balanceMinor: number;
  creditedMinor: number;
  appliedMinor: number;
  refundedMinor: number;
  movements: CreditMovementRow[];
}

const MOVEMENT_ROW = {
  id: true,
  movement: true,
  amountMinor: true,
  reason: true,
  appliedChargeId: true,
  createdAt: true,
  actorUser: { select: { fullName: true } },
  sourcePayment: { select: { receiptNumber: true } },
} as const;

/**
 * The balance, read from the view rather than summed here.
 *
 * Two readers of the same number must not disagree, and the view is what the solvency trigger and
 * `visit_charge_balances` are both written against.
 */
async function balanceOf(tx: TransactionClient, patientId: string): Promise<{
  balanceMinor: number;
  creditedMinor: number;
  appliedMinor: number;
  refundedMinor: number;
}> {
  const rows = await tx.$queryRaw<
    { balance_minor: number; credited_minor: number; applied_minor: number; refunded_minor: number }[]
  >`SELECT balance_minor, credited_minor, applied_minor, refunded_minor
      FROM patient_credit_balances WHERE patient_id = ${patientId}::uuid`;
  const row = rows[0];
  return {
    balanceMinor: row?.balance_minor ?? 0,
    creditedMinor: row?.credited_minor ?? 0,
    appliedMinor: row?.applied_minor ?? 0,
    refundedMinor: row?.refunded_minor ?? 0,
  };
}

/** The ledger a patient card and the desk both show: the balance, and how it got there. */
export async function getCreditLedger(
  caller: CallerContext,
  patientId: string,
): Promise<CreditResult<CreditLedger>> {
  return withTenant(caller.tenantId, caller.actor, async (tx) => {
    const patient = await tx.patient.findFirst({ where: { id: patientId }, select: { id: true } });
    if (patient === null) {
      return { ok: false as const, code: "NOT_FOUND" as const, params: { resource: "patient" as const } };
    }

    const totals = await balanceOf(tx, patientId);
    const rows = await tx.patientCredit.findMany({
      where: { patientId },
      select: MOVEMENT_ROW,
      orderBy: { createdAt: "desc" },
    });

    return {
      ok: true as const,
      value: {
        patientId,
        ...totals,
        movements: rows.map((row) => ({
          id: row.id,
          movement: row.movement,
          amountMinor: row.amountMinor,
          reason: row.reason,
          actorName: row.actorUser.fullName,
          receiptNumber: row.sourcePayment?.receiptNumber ?? null,
          appliedChargeId: row.appliedChargeId,
          at: row.createdAt.toISOString(),
        })),
      },
    };
  });
}

/**
 * Turns money the clinic could not refuse into credit.
 *
 * Takes a `tx` because it always runs in the transaction of the event that made the money
 * unallocatable: a bill that came in under the pre-payment, or an appointment that ended without
 * one. A credit that failed to follow its event is money the clinic has and the patient cannot see.
 */
export async function creditFromPayment(
  tx: TransactionClient,
  input: { patientId: string; paymentId: string; amountMinor: number; actorUserId: string; reason: string },
): Promise<void> {
  if (input.amountMinor <= 0) return;
  await tx.patientCredit.create({
    data: injected({
      id: randomUUID(),
      patientId: input.patientId,
      movement: "CREDIT",
      amountMinor: input.amountMinor,
      reason: input.reason,
      actorUserId: input.actorUserId,
      sourcePaymentId: input.paymentId,
    }),
  });
}

/**
 * **A pre-paid appointment that is cancelled or abandoned becomes credit** — R-A.
 *
 * The money was taken against an appointment that will now never produce a bill, so there is
 * nothing to refuse and nothing to attach it to. Hooked into the two choke points every terminal
 * transition passes through, in their transaction: an appointment that closes and the credit it
 * owes commit together, or neither does.
 */
export async function creditAbandonedPrePayments(
  tx: TransactionClient,
  actorUserId: string,
  appointmentId: string,
  status: AppointmentStatus,
): Promise<void> {
  if (status !== "CANCELLED" && status !== "NO_SHOW") return;

  const payments = await tx.payment.findMany({
    where: { appointmentId, chargeId: null },
    select: { id: true, patientId: true, amountMinor: true },
  });
  if (payments.length === 0) return;

  // Both statuses are terminal, so this cannot run twice — but "cannot" is a property of the state
  // machine and this is money, so the rows it would duplicate are read rather than reasoned about.
  const credited = new Set(
    (
      await tx.patientCredit.findMany({
        where: { movement: "CREDIT", sourcePaymentId: { in: payments.map((payment) => payment.id) } },
        select: { sourcePaymentId: true },
      })
    ).map((row) => row.sourcePaymentId),
  );

  for (const payment of payments) {
    if (credited.has(payment.id)) continue;
    await creditFromPayment(tx, {
      patientId: payment.patientId,
      paymentId: payment.id,
      amountMinor: payment.amountMinor,
      actorUserId,
      reason:
        status === "CANCELLED"
          ? CREDIT_ORIGIN.appointmentCancelled
          : CREDIT_ORIGIN.appointmentNotAttended,
    });
  }
}

/**
 * Spends credit against a charge.
 *
 * **The database decides whether there is enough**, not this function: the solvency trigger sums the
 * ledger inside the transaction, so two receptionists applying the same credit at once cannot both
 * pass a check against the same stale figure. The read below is for the sentence, not the rule.
 */
export async function applyCreditToCharge(
  caller: CallerContext,
  input: { chargeId: string; amountMinor: number },
): Promise<CreditResult<{ appliedMinor: number; balanceMinor: number }>> {
  if (input.amountMinor <= 0) {
    return { ok: false, code: "AMOUNT_NOT_POSITIVE", params: {} };
  }

  return withTenant(caller.tenantId, caller.actor, async (tx) => {
    const charge = await tx.visitCharge.findFirst({
      where: { id: input.chargeId },
      select: { id: true, patientId: true },
    });
    if (charge === null) {
      return { ok: false as const, code: "NOT_FOUND" as const, params: { resource: "charge" as const } };
    }

    const before = await balanceOf(tx, charge.patientId);
    if (input.amountMinor > before.balanceMinor) {
      return {
        ok: false as const,
        code: "INSUFFICIENT_CREDIT" as const,
        params: { limit: before.balanceMinor, actual: input.amountMinor },
      };
    }

    // **Credit applied is a payment against the charge** — R-A's rule reaches it by the same route:
    // spending more than the bill still owes would drive the balance below zero, which is the thing
    // the refusal exists to prevent. Locked before the read, like the desk's.
    await tx.$queryRaw`SELECT id FROM visit_charges WHERE id = ${input.chargeId}::uuid FOR UPDATE`;
    const owed = await tx.$queryRaw<{ balance_minor: number }[]>`
      SELECT balance_minor FROM visit_charge_balances WHERE charge_id = ${input.chargeId}::uuid`;
    const remaining = Math.max(0, owed[0]?.balance_minor ?? 0);
    if (input.amountMinor > remaining) {
      return {
        ok: false as const,
        code: "PAYMENT_EXCEEDS_BALANCE" as const,
        params: { limit: remaining, actual: input.amountMinor },
      };
    }

    await tx.patientCredit.create({
      data: injected({
        id: randomUUID(),
        patientId: charge.patientId,
        movement: "APPLIED",
        amountMinor: input.amountMinor,
        actorUserId: caller.actor.userId,
        appliedChargeId: input.chargeId,
      }),
    });

    const after = await balanceOf(tx, charge.patientId);
    return { ok: true as const, value: { appliedMinor: input.amountMinor, balanceMinor: after.balanceMinor } };
  });
}

/**
 * Gives credit back, on request, with a reason.
 *
 * **Never forfeited** is the other half of ruling 5: nothing here expires a balance and nothing
 * deletes a movement, so the only ways credit leaves are settling a bill and being handed back.
 */
export async function refundCredit(
  caller: CallerContext,
  input: { patientId: string; amountMinor: number; reason: string },
): Promise<CreditResult<{ refundedMinor: number; balanceMinor: number }>> {
  if (input.amountMinor <= 0) {
    return { ok: false, code: "AMOUNT_NOT_POSITIVE", params: {} };
  }
  if (input.reason.trim() === "") {
    return { ok: false, code: "REFUND_REASON_REQUIRED", params: {} };
  }

  return withTenant(caller.tenantId, caller.actor, async (tx) => {
    const patient = await tx.patient.findFirst({ where: { id: input.patientId }, select: { id: true } });
    if (patient === null) {
      return { ok: false as const, code: "NOT_FOUND" as const, params: { resource: "patient" as const } };
    }

    const before = await balanceOf(tx, input.patientId);
    if (input.amountMinor > before.balanceMinor) {
      return {
        ok: false as const,
        code: "INSUFFICIENT_CREDIT" as const,
        params: { limit: before.balanceMinor, actual: input.amountMinor },
      };
    }

    await tx.patientCredit.create({
      data: injected({
        id: randomUUID(),
        patientId: input.patientId,
        movement: "REFUNDED",
        amountMinor: input.amountMinor,
        reason: input.reason.trim(),
        actorUserId: caller.actor.userId,
      }),
    });

    const after = await balanceOf(tx, input.patientId);
    return { ok: true as const, value: { refundedMinor: input.amountMinor, balanceMinor: after.balanceMinor } };
  });
}
