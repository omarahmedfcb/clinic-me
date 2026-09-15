// The «المدفوعات» screen's data — R2. One shape, scoped by who is asking: reception and admin see
// the clinic, a doctor sees their own patients, and only the first two may act on it.

import { calendarDayIn, instantsForLocal } from "../appointments/domain/zoned-time.ts";
import { doctorIdForMembership } from "../clinical/clinical.access.ts";
import { withTenant, type ActorContext, type TransactionClient } from "../../prisma/with-tenant.ts";

export interface PaymentsCaller {
  tenantId: string;
  actor: ActorContext;
  role: string;
  membershipId: string;
}

export interface ChargeRow {
  chargeId: string;
  visitId: string;
  patientId: string;
  patientName: string;
  doctorName: string;
  status: string;
  subtotalMinor: number;
  discountMinor: number;
  paidMinor: number;
  balanceMinor: number;
  /** True when this charge was written today; an older one is here because it is still owed. */
  today: boolean;
}

export interface ReceiptRow {
  paymentId: string;
  receiptNumber: number;
  patientName: string;
  amountMinor: number;
  method: string;
  collectedBy: string | null;
}

export interface AdjustmentRow {
  visitId: string;
  patientName: string;
  doctorName: string;
  amountMinor: number;
  reason: string | null;
  at: string;
}

export interface AboveCeilingRow {
  chargeId: string;
  patientName: string;
  discountMinor: number;
  reason: string | null;
  authorisedBy: string | null;
}

export interface PaymentsOverview {
  /** The clinic's own calendar day, not the server's. */
  day: string;
  byMethod: { method: string; totalMinor: number }[];
  collectedTodayMinor: number;
  outstandingMinor: number;
  charges: ChargeRow[];
  receipts: ReceiptRow[];
  adjustments: AdjustmentRow[];
  aboveCeiling: AboveCeilingRow[];
  /** Whether this caller may issue and collect from here at all (R2). */
  mayCollect: boolean;
}

/** Balances come from the view, never from arithmetic here (D7 as amended). */
async function balancesFor(
  tx: TransactionClient,
  chargeIds: string[],
): Promise<Map<string, { paid: number; balance: number }>> {
  if (chargeIds.length === 0) return new Map();
  const rows = await tx.$queryRaw<
    { charge_id: string; paid_minor: number; balance_minor: number }[]
  >`SELECT charge_id, paid_minor, balance_minor
      FROM visit_charge_balances WHERE charge_id = ANY(${chargeIds}::uuid[])`;
  return new Map(rows.map((row) => [row.charge_id, { paid: row.paid_minor, balance: row.balance_minor }]));
}

/**
 * Everything the screen renders, in one round trip.
 *
 * **A doctor's figures are their own patients' figures.** Scoping the list but not the totals would
 * hand a doctor the clinic's takings as a subtraction, so the same filter runs through all of it.
 */
export async function getPaymentsOverview(
  caller: PaymentsCaller,
  now: Date,
): Promise<PaymentsOverview> {
  return withTenant(caller.tenantId, caller.actor, async (tx) => {
    const tenant = await tx.tenant.findFirstOrThrow({ select: { timezone: true } });
    const day = calendarDayIn(now, tenant.timezone);
    // The earlier instant on an ambiguous midnight: a day that begins twice begins at the first.
    const dayStart = instantsForLocal(day, 0, tenant.timezone)[0] ?? new Date(`${day}T00:00:00Z`);

    const doctorId = caller.role === "DOCTOR" ? await doctorIdForMembership(tx, caller.membershipId) : null;
    const mine = doctorId === null ? {} : { visit: { doctorId } };
    const doctor =
      doctorId === null
        ? null
        : await tx.doctor.findFirst({ where: { id: doctorId }, select: { collectsPayments: true } });
    const mayCollect = doctorId === null ? caller.role === "RECEPTIONIST" : doctor?.collectsPayments === true;

    // Today's charges, plus anything still owed from before — an outstanding balance is the reason
    // the desk goes looking, and it does not stop being owed at midnight.
    const charges = await tx.visitCharge.findMany({
      where: { ...mine, OR: [{ createdAt: { gte: dayStart } }, { status: "OPEN" }] },
      select: {
        id: true,
        visitId: true,
        patientId: true,
        status: true,
        subtotalMinor: true,
        discountMinor: true,
        discountReason: true,
        ceilingPercentSnapshot: true,
        ceilingMinorSnapshot: true,
        createdAt: true,
        patient: { select: { fullNameAr: true } },
        discountAuthorisedBy: { select: { fullName: true } },
        visit: {
          select: {
            priceAdjustmentMinor: true,
            priceAdjustmentReason: true,
            priceAdjustedAt: true,
            doctor: { select: { printedName: true, membership: { select: { user: { select: { fullName: true } } } } } },
          },
        },
      },
      orderBy: { createdAt: "desc" },
    });

    const balances = await balancesFor(tx, charges.map((charge) => charge.id));
    const doctorName = (charge: (typeof charges)[number]): string =>
      charge.visit.doctor.printedName ?? charge.visit.doctor.membership.user.fullName;

    const receipts = await tx.payment.findMany({
      where: { receiptDate: new Date(`${day}T00:00:00.000Z`), ...(doctorId === null ? {} : { visit: { doctorId } }) },
      select: {
        id: true,
        receiptNumber: true,
        amountMinor: true,
        method: true,
        patient: { select: { fullNameAr: true } },
        collectedByUser: { select: { fullName: true } },
      },
      orderBy: { receiptNumber: "desc" },
    });

    const byMethod = new Map<string, number>();
    for (const receipt of receipts) {
      byMethod.set(receipt.method, (byMethod.get(receipt.method) ?? 0) + receipt.amountMinor);
    }

    return {
      day,
      byMethod: [...byMethod].map(([method, totalMinor]) => ({ method, totalMinor })),
      collectedTodayMinor: receipts.reduce((total, receipt) => total + receipt.amountMinor, 0),
      outstandingMinor: charges
        .filter((charge) => charge.status === "OPEN")
        .reduce((total, charge) => total + (balances.get(charge.id)?.balance ?? 0), 0),
      charges: charges.map((charge) => ({
        chargeId: charge.id,
        visitId: charge.visitId,
        patientId: charge.patientId,
        patientName: charge.patient.fullNameAr,
        doctorName: doctorName(charge),
        status: charge.status,
        subtotalMinor: charge.subtotalMinor,
        discountMinor: charge.discountMinor,
        paidMinor: balances.get(charge.id)?.paid ?? 0,
        balanceMinor: balances.get(charge.id)?.balance ?? 0,
        today: charge.createdAt >= dayStart,
      })),
      receipts: receipts.map((receipt) => ({
        paymentId: receipt.id,
        receiptNumber: receipt.receiptNumber,
        patientName: receipt.patient.fullNameAr,
        amountMinor: receipt.amountMinor,
        method: receipt.method,
        collectedBy: receipt.collectedByUser?.fullName ?? null,
      })),
      // R1's oversight: the adjustments are the record an admin reads instead of a review queue.
      adjustments: charges
        .filter((charge) => charge.visit.priceAdjustmentMinor != null)
        .map((charge) => ({
          visitId: charge.visitId,
          patientName: charge.patient.fullNameAr,
          doctorName: doctorName(charge),
          amountMinor: charge.visit.priceAdjustmentMinor as number,
          reason: charge.visit.priceAdjustmentReason,
          at: (charge.visit.priceAdjustedAt as Date).toISOString(),
        })),
      // An authoriser is named only when the discount went above the ceiling (ruling 4), so the
      // column doubles as the flag.
      aboveCeiling: charges
        .filter((charge) => charge.discountAuthorisedBy !== null)
        .map((charge) => ({
          chargeId: charge.id,
          patientName: charge.patient.fullNameAr,
          discountMinor: charge.discountMinor,
          reason: charge.discountReason,
          authorisedBy: charge.discountAuthorisedBy?.fullName ?? null,
        })),
      mayCollect,
    };
  });
}
