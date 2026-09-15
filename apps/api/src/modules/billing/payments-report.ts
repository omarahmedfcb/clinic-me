// «تقارير المدفوعات» — Phase 5 PR 14, asked for by the founder 2026-09-13. Read-only.
// A doctor's report is their own patients' figures, narrowed explicitly rather than incidentally.

import { calendarDayIn, instantsForLocal } from "../appointments/domain/zoned-time.ts";
import { doctorIdForMembership } from "../clinical/clinical.access.ts";
import { withTenant, type ActorContext, type TransactionClient } from "../../prisma/with-tenant.ts";

export interface ReportCaller {
  tenantId: string;
  actor: ActorContext;
  role: string;
  membershipId: string;
}

export type ReportPeriod = "DAY" | "MONTH";

export interface DoctorTotals {
  doctorId: string;
  doctorName: string;
  /** Money actually received in the period, against this doctor's visits. */
  collectedMinor: number;
  /** What their charges came to in the period, after discount and the payer's share. */
  chargedMinor: number;
  /** Still owed on their charges — as at now, because a debt does not expire with the period. */
  outstandingMinor: number;
  charges: number;
}

export interface OutstandingRow {
  chargeId: string;
  patientName: string;
  doctorName: string;
  issuedOn: string;
  balanceMinor: number;
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
  doctorName: string;
  discountMinor: number;
  reason: string | null;
  authorisedBy: string | null;
}

export interface PaymentsReport {
  period: ReportPeriod;
  /** The clinic's own calendar label: `YYYY-MM-DD` for a day, `YYYY-MM` for a month. */
  on: string;
  from: string;
  to: string;
  collectedMinor: number;
  byMethod: { method: string; totalMinor: number }[];
  byDoctor: DoctorTotals[];
  outstandingMinor: number;
  outstanding: OutstandingRow[];
  adjustments: AdjustmentRow[];
  aboveCeiling: AboveCeilingRow[];
  /**
   * Whose figures these are. A doctor reading `OWN` must be told so on the screen — a total that
   * looks like the clinic's and is not is the kind of number somebody makes a decision on.
   */
  scope: "CLINIC" | "OWN";
}

export type ReportResult =
  | { ok: true; value: PaymentsReport }
  | { ok: false; code: "INVALID_PERIOD" };

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MONTH = /^\d{4}-\d{2}$/;

/** The calendar bounds of the requested period, inclusive at both ends. */
function boundsOf(period: ReportPeriod, on: string): { from: string; to: string } | null {
  if (period === "DAY") return DAY.test(on) ? { from: on, to: on } : null;
  if (!MONTH.test(on)) return null;
  const [year, month] = on.split("-").map(Number) as [number, number];
  // Day zero of the next month is the last day of this one, which is how February is got right
  // without a table of month lengths.
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { from: `${on}-01`, to: `${on}-${String(last).padStart(2, "0")}` };
}

/** Balances come from the view, never from arithmetic here (D7 as amended). */
async function balancesFor(
  tx: TransactionClient,
  chargeIds: string[],
): Promise<Map<string, { paid: number; balance: number; patientShare: number }>> {
  if (chargeIds.length === 0) return new Map();
  const rows = await tx.$queryRaw<
    { charge_id: string; paid_minor: number; balance_minor: number; patient_share_minor: number }[]
  >`SELECT charge_id, paid_minor, balance_minor, patient_share_minor
      FROM visit_charge_balances WHERE charge_id = ANY(${chargeIds}::uuid[])`;
  return new Map(
    rows.map((row) => [
      row.charge_id,
      { paid: row.paid_minor, balance: row.balance_minor, patientShare: row.patient_share_minor },
    ]),
  );
}

/**
 * The report, for a day or a month.
 *
 * **A DOCTOR's report is narrowed explicitly**, which the capability registry asked for in as many
 * words when `reports.financial` had no consumer: *"scope a DOCTOR's report to their own data
 * explicitly rather than relying on a WHERE clause that happens to be right, and test the refusal."*
 * So the doctor filter is resolved once, applied to every query below including the totals, and the
 * answer says which scope it is — a total that looks like the clinic's and is not is worse than no
 * total at all.
 *
 * `now` is a parameter: "which month is this" is a question about the clinic's own calendar, and a
 * boundary that reads its own clock cannot be tested at the boundary (CLAUDE.md).
 */
export async function getPaymentsReport(
  caller: ReportCaller,
  input: { period: ReportPeriod; on?: string },
  now: Date,
): Promise<ReportResult> {
  return withTenant(caller.tenantId, caller.actor, async (tx) => {
    const tenant = await tx.tenant.findFirstOrThrow({ select: { timezone: true } });
    const today = calendarDayIn(now, tenant.timezone);
    const on = input.on ?? (input.period === "DAY" ? today : today.slice(0, 7));
    const bounds = boundsOf(input.period, on);
    if (bounds === null) return { ok: false as const, code: "INVALID_PERIOD" as const };

    const doctorId =
      caller.role === "DOCTOR" ? await doctorIdForMembership(tx, caller.membershipId) : null;
    const mine = doctorId === null ? {} : { visit: { doctorId } };

    // The earlier instant on an ambiguous midnight: a day that begins twice begins at the first.
    const from = instantsForLocal(bounds.from, 0, tenant.timezone)[0] ?? new Date(`${bounds.from}T00:00:00Z`);
    const until =
      instantsForLocal(bounds.to, 24 * 60, tenant.timezone)[0] ?? new Date(`${bounds.to}T23:59:59Z`);

    const receipts = await tx.payment.findMany({
      where: {
        receiptDate: { gte: new Date(`${bounds.from}T00:00:00.000Z`), lte: new Date(`${bounds.to}T00:00:00.000Z`) },
        ...(doctorId === null ? {} : { visit: { doctorId } }),
      },
      select: {
        amountMinor: true,
        method: true,
        visit: {
          select: {
            doctorId: true,
            doctor: { select: { printedName: true, membership: { select: { user: { select: { fullName: true } } } } } },
          },
        },
      },
    });

    // Charges written in the period, for what was billed; plus everything still open, for what is
    // owed. The two questions have different windows and collapsing them would answer neither.
    const charges = await tx.visitCharge.findMany({
      where: { ...mine, OR: [{ createdAt: { gte: from, lt: until } }, { status: "OPEN" }] },
      select: {
        id: true,
        visitId: true,
        status: true,
        discountMinor: true,
        discountReason: true,
        createdAt: true,
        patient: { select: { fullNameAr: true } },
        discountAuthorisedBy: { select: { fullName: true } },
        visit: {
          select: {
            doctorId: true,
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
    type Named = { printedName: string | null; membership: { user: { fullName: string } } };
    const nameOf = (doctor: Named): string => doctor.printedName ?? doctor.membership.user.fullName;
    const inPeriod = (charge: (typeof charges)[number]): boolean =>
      charge.createdAt >= from && charge.createdAt < until;

    const byMethod = new Map<string, number>();
    for (const receipt of receipts) {
      byMethod.set(receipt.method, (byMethod.get(receipt.method) ?? 0) + receipt.amountMinor);
    }

    const perDoctor = new Map<string, DoctorTotals>();
    const totalsFor = (id: string, name: string): DoctorTotals => {
      const existing = perDoctor.get(id);
      if (existing !== undefined) return existing;
      const fresh = {
        doctorId: id,
        doctorName: name,
        collectedMinor: 0,
        chargedMinor: 0,
        outstandingMinor: 0,
        charges: 0,
      };
      perDoctor.set(id, fresh);
      return fresh;
    };

    for (const receipt of receipts) {
      // A receipt with no visit is a pre-payment that never became a bill; it has no doctor to
      // attribute to and is counted in the clinic's total below rather than invented onto one.
      if (receipt.visit === null) continue;
      totalsFor(receipt.visit.doctorId, nameOf(receipt.visit.doctor)).collectedMinor += receipt.amountMinor;
    }

    for (const charge of charges) {
      const totals = totalsFor(charge.visit.doctorId, nameOf(charge.visit.doctor));
      if (inPeriod(charge)) {
        totals.chargedMinor += balances.get(charge.id)?.patientShare ?? 0;
        totals.charges += 1;
      }
      if (charge.status === "OPEN") totals.outstandingMinor += balances.get(charge.id)?.balance ?? 0;
    }

    const outstanding = charges.filter((charge) => charge.status === "OPEN");

    return {
      ok: true as const,
      value: {
        period: input.period,
        on,
        from: bounds.from,
        to: bounds.to,
        collectedMinor: receipts.reduce((total, receipt) => total + receipt.amountMinor, 0),
        byMethod: [...byMethod]
          .map(([method, totalMinor]) => ({ method, totalMinor }))
          .sort((a, b) => b.totalMinor - a.totalMinor),
        byDoctor: [...perDoctor.values()].sort((a, b) => b.collectedMinor - a.collectedMinor),
        outstandingMinor: outstanding.reduce(
          (total, charge) => total + (balances.get(charge.id)?.balance ?? 0),
          0,
        ),
        outstanding: outstanding.map((charge) => ({
          chargeId: charge.id,
          patientName: charge.patient.fullNameAr,
          doctorName: nameOf(charge.visit.doctor),
          issuedOn: charge.createdAt.toISOString().slice(0, 10),
          balanceMinor: balances.get(charge.id)?.balance ?? 0,
        })),
        // R1's oversight: the adjustments an admin reads instead of a review queue.
        adjustments: charges
          .filter((charge) => inPeriod(charge) && charge.visit.priceAdjustmentMinor != null)
          .map((charge) => ({
            visitId: charge.visitId,
            patientName: charge.patient.fullNameAr,
            doctorName: nameOf(charge.visit.doctor),
            amountMinor: charge.visit.priceAdjustmentMinor as number,
            reason: charge.visit.priceAdjustmentReason,
            at: (charge.visit.priceAdjustedAt as Date).toISOString(),
          })),
        // An authoriser is named only when the discount went above the ceiling (ruling 4), so the
        // column doubles as the flag.
        aboveCeiling: charges
          .filter((charge) => inPeriod(charge) && charge.discountAuthorisedBy !== null)
          .map((charge) => ({
            chargeId: charge.id,
            patientName: charge.patient.fullNameAr,
            doctorName: nameOf(charge.visit.doctor),
            discountMinor: charge.discountMinor,
            reason: charge.discountReason,
            authorisedBy: charge.discountAuthorisedBy?.fullName ?? null,
          })),
        scope: doctorId === null ? ("CLINIC" as const) : ("OWN" as const),
      },
    };
  });
}
