// The desk — Phase 5 PR 9. What a visit costs, what has been paid, and the receipt for each payment.

import { randomUUID } from "node:crypto";
import type { PaymentMethod } from "../../generated/prisma/enums.ts";
import type { RefusalParams } from "../../common/refusals.ts";
import { injected } from "../../prisma/injected.ts";
import { withTenant, type ActorContext, type TransactionClient } from "../../prisma/with-tenant.ts";
import { doctorIdForMembership } from "../clinical/clinical.access.ts";

export type DeskRefusalReason =
  | "NOT_FOUND"
  | "DISCOUNT_ABOVE_CEILING"
  | "SPLIT_EXCEEDS_CHARGE"
  | "ALREADY_SETTLED"
  | "COLLECTION_NOT_ALLOWED"
  | "PAYMENT_EXCEEDS_BALANCE";

/** Who is asking. `role` and `membershipId` decide `own`, and both come from the validated JWT. */
export interface DeskCaller {
  tenantId: string;
  actor: ActorContext;
  role: string;
  membershipId: string;
}

/**
 * The doctor this caller is, when they are one (R2: `payments.read` and `payments.record` are `own`
 * for a doctor). Null for every other role, which means no narrowing rather than no access.
 */
async function callerDoctorId(tx: TransactionClient, caller: DeskCaller): Promise<string | null> {
  if (caller.role !== "DOCTOR") return null;
  return doctorIdForMembership(tx, caller.membershipId);
}

export type DeskResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: DeskRefusalReason; params: RefusalParams };

export interface ChargeLineView {
  id: string;
  nameSnapshot: string;
  unitPriceMinor: number;
  quantity: number;
  source: string;
  /** Set on an ADJUSTMENT line: the doctor who moved the total, and why (R1). */
  adjustedBy: string | null;
  adjustmentReason: string | null;
}

export interface ReceiptView {
  paymentId: string;
  receiptNumber: number;
  receiptDate: string;
  amountMinor: number;
  method: string;
  collectedBy: string | null;
}

export interface DeskCharge {
  chargeId: string;
  visitId: string;
  patientId: string;
  patientName: string;
  /** Sequential per clinic. The printed invoice carries it, because that is how a file is found. */
  patientFileNumber: number;
  /** The day the charge was written, as a calendar day: an invoice is dated, not timestamped. */
  issuedOn: string;
  status: string;
  subtotalMinor: number;
  discountMinor: number;
  discountReason: string | null;
  payerShareMinor: number;
  patientShareMinor: number;
  paidMinor: number;
  balanceMinor: number;
  /** The lower of whichever ceilings this charge was written under. Null means no ceiling applied. */
  discountCeilingMinor: number | null;
  lines: ChargeLineView[];
  receipts: ReceiptView[];
}

const CEILING = (subtotal: number, percent: number | null, minor: number | null): number | null => {
  const fromPercent = percent === null ? null : Math.floor((subtotal * percent) / 100);
  const candidates = [fromPercent, minor].filter((value): value is number => value !== null);
  // `LEAST` ignoring nulls, in TypeScript: a clinic that sets only one half is bound by that one.
  return candidates.length === 0 ? null : Math.min(...candidates);
};

export async function getDeskCharge(
  caller: DeskCaller,
  chargeId: string,
): Promise<DeskResult<DeskCharge>> {
  return withTenant(caller.tenantId, caller.actor, async (tx) =>
    readCharge(tx, chargeId, await callerDoctorId(tx, caller)),
  );
}

/**
 * The read itself, taking the transaction.
 *
 * Separated from `getDeskCharge` so a caller that has *just written* can re-read inside the same
 * transaction. Opening a second one would not see the uncommitted write, and the desk would render
 * the figure it had before the discount it just applied -- which looks exactly like a failed save.
 */
async function readCharge(
  tx: Parameters<Parameters<typeof withTenant>[2]>[0],
  chargeId: string,
  doctorId: string | null = null,
): Promise<DeskResult<DeskCharge>> {
  {
    const charge = await tx.visitCharge.findFirst({
      // A doctor's `own` is enforced by narrowing the query, not by checking after: a colleague's
      // charge is simply not there, and the refusal is the same NOT_FOUND as a wrong id.
      where: doctorId === null ? { id: chargeId } : { id: chargeId, visit: { doctorId } },
      select: {
        id: true,
        visitId: true,
        patientId: true,
        status: true,
        subtotalMinor: true,
        discountMinor: true,
        discountReason: true,
        payerShareMinor: true,
        ceilingPercentSnapshot: true,
        ceilingMinorSnapshot: true,
        createdAt: true,
        patient: { select: { fullNameAr: true, fileNumber: true } },
        visit: { select: { priceAdjustmentReason: true } },
        lines: {
          select: {
            id: true,
            nameSnapshot: true,
            unitPriceMinor: true,
            quantity: true,
            source: true,
            adjustedBy: { select: { fullName: true } },
          },
          orderBy: { createdAt: "asc" },
        },
        payments: {
          select: {
            id: true,
            receiptNumber: true,
            receiptDate: true,
            amountMinor: true,
            method: true,
            collectedByUser: { select: { fullName: true } },
          },
          orderBy: { receiptNumber: "asc" },
        },
      },
    });
    if (charge === null) {
      return { ok: false as const, code: "NOT_FOUND" as const, params: { resource: "visit" as const } };
    }

    // The money that is *derived* comes from the view, never from arithmetic here (D7 as amended).
    const balances = await tx.$queryRaw<
      { patient_share_minor: number; paid_minor: number; balance_minor: number }[]
    >`SELECT patient_share_minor, paid_minor, balance_minor
        FROM visit_charge_balances WHERE charge_id = ${chargeId}::uuid`;
    const balance = balances[0];

    return {
      ok: true as const,
      value: {
        chargeId: charge.id,
        visitId: charge.visitId,
        patientId: charge.patientId,
        patientName: charge.patient.fullNameAr,
        patientFileNumber: charge.patient.fileNumber,
        issuedOn: charge.createdAt.toISOString().slice(0, 10),
        status: charge.status,
        subtotalMinor: charge.subtotalMinor,
        discountMinor: charge.discountMinor,
        discountReason: charge.discountReason,
        payerShareMinor: charge.payerShareMinor,
        patientShareMinor: balance?.patient_share_minor ?? 0,
        paidMinor: balance?.paid_minor ?? 0,
        balanceMinor: balance?.balance_minor ?? 0,
        discountCeilingMinor: CEILING(
          charge.subtotalMinor,
          charge.ceilingPercentSnapshot,
          charge.ceilingMinorSnapshot,
        ),
        lines: charge.lines.map(({ adjustedBy, ...line }) => ({
          ...line,
          adjustedBy: adjustedBy?.fullName ?? null,
          // The reason lives on the visit the adjustment was made against; the line carries the
          // money and the person.
          adjustmentReason: adjustedBy === null ? null : charge.visit.priceAdjustmentReason,
        })),
        receipts: charge.payments.map((payment) => ({
          paymentId: payment.id,
          receiptNumber: payment.receiptNumber,
          receiptDate: payment.receiptDate.toISOString().slice(0, 10),
          amountMinor: payment.amountMinor,
          method: payment.method,
          collectedBy: payment.collectedByUser?.fullName ?? null,
        })),
      },
    };
  }
}

/**
 * Applies a discount.
 *
 * **Above the ceiling needs an authoriser, and only owner or admin may be one** (ruling 4). The
 * database refuses an unauthorised discount above the ceiling regardless; this decides whether the
 * caller is entitled to be the authoriser, which is a question about the person rather than about
 * the row and therefore cannot live in a `CHECK`.
 */
export async function applyDiscount(
  caller: DeskCaller,
  chargeId: string,
  input: { discountMinor: number; reason: string },
): Promise<DeskResult<DeskCharge>> {
  return withTenant(caller.tenantId, caller.actor, async (tx) => {
    const charge = await tx.visitCharge.findFirst({
      where: { id: chargeId },
      select: {
        id: true,
        subtotalMinor: true,
        status: true,
        ceilingPercentSnapshot: true,
        ceilingMinorSnapshot: true,
      },
    });
    if (charge === null) {
      return { ok: false as const, code: "NOT_FOUND" as const, params: { resource: "visit" as const } };
    }
    if (charge.status === "VOID") {
      return { ok: false as const, code: "ALREADY_SETTLED" as const, params: {} };
    }

    const ceiling = CEILING(
      charge.subtotalMinor,
      charge.ceilingPercentSnapshot,
      charge.ceilingMinorSnapshot,
    );
    const aboveCeiling = ceiling !== null && input.discountMinor > ceiling;
    const mayExceed = caller.role === "OWNER" || caller.role === "ADMIN";

    if (aboveCeiling && !mayExceed) {
      return {
        ok: false as const,
        code: "DISCOUNT_ABOVE_CEILING" as const,
        params: { limit: ceiling, actual: input.discountMinor },
      };
    }

    await tx.visitCharge.update({
      where: { id: chargeId },
      data: {
        discountMinor: input.discountMinor,
        discountReason: input.discountMinor === 0 ? null : input.reason,
        // Named rather than flagged: "who allowed this" is what anyone looking at the invoice asks.
        discountAuthorisedByUserId: aboveCeiling ? caller.actor.userId : null,
      },
    });

    // Re-read inside this transaction, so the desk sees what it just wrote.
    return readCharge(tx, chargeId, await callerDoctorId(tx, caller));
  });
}

/**
 * Records money handed over. Several per charge: two part-payments in cash then Instapay is ordinary.
 *
 * **A doctor collects only with `collects_payments` set, and only for their own patients** (R2).
 * The flag is a fact about one person, so it is checked here rather than in the capability matrix;
 * the ownership half is a narrowed query, so a colleague's charge refuses as NOT_FOUND.
 */
export async function recordPayment(
  caller: DeskCaller,
  input: {
    chargeId: string | null;
    patientId: string;
    appointmentId: string | null;
    amountMinor: number;
    method: PaymentMethod;
  },
  now: Date,
): Promise<DeskResult<ReceiptView>> {
  return withTenant(caller.tenantId, caller.actor, async (tx) => {
    const doctorId = await callerDoctorId(tx, caller);
    if (doctorId !== null) {
      const doctor = await tx.doctor.findFirst({
        where: { id: doctorId },
        select: { collectsPayments: true },
      });
      if (doctor?.collectsPayments !== true) {
        return { ok: false as const, code: "COLLECTION_NOT_ALLOWED" as const, params: {} };
      }
      if (input.appointmentId !== null) {
        const mine = await tx.appointment.findFirst({
          where: { id: input.appointmentId, doctorId },
          select: { id: true },
        });
        if (mine === null) {
          return { ok: false as const, code: "NOT_FOUND" as const, params: { resource: "appointment" as const } };
        }
      }
    }

    // **Money always names what it is for** — R-A. A receipt belonging to neither a charge nor an
    // appointment is money no screen can ever show the patient, and refusing it is possible.
    if (input.chargeId === null && input.appointmentId === null) {
      return { ok: false as const, code: "NOT_FOUND" as const, params: { resource: "visit" as const } };
    }

    let visitId: string | null = null;
    if (input.chargeId !== null) {
      const charge = await tx.visitCharge.findFirst({
        where: doctorId === null ? { id: input.chargeId } : { id: input.chargeId, visit: { doctorId } },
        select: { visitId: true },
      });
      if (charge === null) {
        return { ok: false as const, code: "NOT_FOUND" as const, params: { resource: "visit" as const } };
      }
      visitId = charge.visitId;

      // **More than the patient owes is refused** — R-A, reversing ruling 5's desk half: credit is
      // only for money the clinic could not refuse, and this it can. The charge row is locked before
      // the balance is read, or two receptionists would both pass against the same stale figure.
      await tx.$queryRaw`SELECT id FROM visit_charges WHERE id = ${input.chargeId}::uuid FOR UPDATE`;
      const balances = await tx.$queryRaw<{ balance_minor: number }[]>`
        SELECT balance_minor FROM visit_charge_balances WHERE charge_id = ${input.chargeId}::uuid`;
      const remaining = Math.max(0, balances[0]?.balance_minor ?? 0);
      if (input.amountMinor > remaining) {
        return {
          ok: false as const,
          code: "PAYMENT_EXCEEDS_BALANCE" as const,
          params: { limit: remaining, actual: input.amountMinor },
        };
      }
    }

    const payment = await tx.payment.create({
      data: injected({
        id: randomUUID(),
        patientId: input.patientId,
        appointmentId: input.appointmentId,
        visitId,
        chargeId: input.chargeId,
        amountMinor: input.amountMinor,
        method: input.method,
        // A receipt is written when money is taken, so it is paid by definition. Whether it settles
        // the whole charge is the balance's business, not this row's.
        status: "PAID",
        collectedByUserId: caller.actor.userId,
        paidAt: now,
      }),
      select: { id: true, receiptNumber: true, receiptDate: true, amountMinor: true, method: true },
    });

    // Read back separately: `create` with a relation in its select is not available on this model,
    // and the collector is the caller, so it is a lookup rather than a join.
    const collector = await tx.user.findFirst({
      where: { id: caller.actor.userId },
      select: { fullName: true },
    });

    return {
      ok: true as const,
      value: {
        paymentId: payment.id,
        receiptNumber: payment.receiptNumber,
        receiptDate: payment.receiptDate.toISOString().slice(0, 10),
        amountMinor: payment.amountMinor,
        method: payment.method,
        collectedBy: collector?.fullName ?? null,
      },
    };
  });
}


