// The visit total the doctor sees before completing, and the signed adjustment they may make to it
// when an admin has allowed it (R1). The adjustment never edits a line; completion copies it onto one.

import type { RefusalParams } from "../../common/refusals.ts";
import { withTenant, type TransactionClient } from "../../prisma/with-tenant.ts";
import type { CallerContext } from "../appointments/appointments.service.ts";
import { doctorIdForMembership } from "./clinical.access.ts";
import { reachVisitForOrders, type OrdersRefusal } from "./visit-orders.ts";
import { visitScope } from "./visit-scope.ts";

export type PricingRefusal =
  | OrdersRefusal
  | { code: "PRICE_ADJUSTMENT_NOT_ALLOWED"; params: RefusalParams }
  | { code: "PRICE_ADJUSTMENT_ABOVE_CAP"; params: RefusalParams };

export type PricingResult<T> = { ok: true; value: T } | { ok: false; refusal: PricingRefusal };

export interface VisitPricing {
  /** The procedures as they stand, priced the way completion will price them. */
  subtotalMinor: number;
  /** Signed. Negative lowers the total. Null when the doctor has not adjusted it. */
  adjustmentMinor: number | null;
  adjustmentReason: string | null;
  adjustedAt: string | null;
  totalMinor: number;
  /** Whether this doctor may move the total at all — the control is absent when false. */
  mayAdjust: boolean;
  /**
   * How far they may move it, against this visit's subtotal. Null means unlimited.
   *
   * Sent so the screen can say the number before the doctor tries, the way the desk names the
   * discount ceiling: a limit you only learn by being refused makes people guess.
   */
  capMinor: number | null;
}

/**
 * The subtotal completion will write, computed the same way `writeChargeForVisit` computes it.
 *
 * Exported so the two cannot drift: a doctor shown one number and billed another has been lied to
 * by the screen, and the lie is invisible until someone reconciles a receipt by hand.
 */
export async function visitSubtotalMinor(tx: TransactionClient, visitId: string): Promise<number> {
  const procedures = await tx.visitProcedure.findMany({
    where: { visitId },
    select: { quantity: true, unitPriceMinor: true, serviceId: true },
  });
  // The catalogue is read at its root, to copy today's price onto a new line — the sanctioned
  // reader that `price-snapshot-is-never-rejoined.spec.ts` distinguishes from re-pricing history.
  const catalogue = new Map(
    (
      await tx.service.findMany({
        where: { id: { in: [...new Set(procedures.map((procedure) => procedure.serviceId))] } },
        select: { id: true, priceMinor: true },
      })
    ).map((service) => [service.id, service.priceMinor]),
  );
  return procedures.reduce(
    (total, procedure) =>
      total +
      (procedure.unitPriceMinor ?? catalogue.get(procedure.serviceId) ?? 0) * procedure.quantity,
    0,
  );
}

interface Permission {
  allowed: boolean;
  capPercent: number | null;
  capMinor: number | null;
}

const NO_PERMISSION: Permission = { allowed: false, capPercent: null, capMinor: null };

async function pricingPermission(
  tx: TransactionClient,
  caller: CallerContext,
): Promise<Permission> {
  const doctorId = await doctorIdForMembership(tx, caller.membershipId);
  if (doctorId === null) return NO_PERMISSION;
  const doctor = await tx.doctor.findFirst({
    where: { id: doctorId },
    select: {
      mayAdjustPrices: true,
      priceAdjustmentCapPercent: true,
      priceAdjustmentCapMinor: true,
    },
  });
  if (doctor?.mayAdjustPrices !== true) return NO_PERMISSION;
  return {
    allowed: true,
    capPercent: doctor.priceAdjustmentCapPercent,
    capMinor: doctor.priceAdjustmentCapMinor,
  };
}

/**
 * How far this doctor may move this visit's total, or null for unlimited.
 *
 * The lower of the two settings binds and either may be absent — the same `LEAST`-ignoring-nulls
 * rule the discount ceiling follows, and the same one the database trigger applies, so the sentence
 * the screen shows and the constraint that refuses cannot disagree.
 */
function capFor(permission: Permission, subtotalMinor: number): number | null {
  const fromPercent =
    permission.capPercent === null
      ? null
      : Math.floor((subtotalMinor * permission.capPercent) / 100);
  const candidates = [fromPercent, permission.capMinor].filter(
    (value): value is number => value !== null,
  );
  return candidates.length === 0 ? null : Math.min(...candidates);
}

const COLUMNS = {
  priceAdjustmentMinor: true,
  priceAdjustmentReason: true,
  priceAdjustedAt: true,
} as const;

async function view(
  tx: TransactionClient,
  caller: CallerContext,
  visitId: string,
): Promise<VisitPricing> {
  const [subtotalMinor, visit, permission] = await Promise.all([
    visitSubtotalMinor(tx, visitId),
    tx.visit.findFirst({ where: { id: visitId, ...visitScope(caller) }, select: COLUMNS }),
    pricingPermission(tx, caller),
  ]);
  const adjustmentMinor = visit?.priceAdjustmentMinor ?? null;
  return {
    subtotalMinor,
    adjustmentMinor,
    adjustmentReason: visit?.priceAdjustmentReason ?? null,
    adjustedAt: visit?.priceAdjustedAt?.toISOString() ?? null,
    totalMinor: subtotalMinor + (adjustmentMinor ?? 0),
    mayAdjust: permission.allowed,
    capMinor: permission.allowed ? capFor(permission, subtotalMinor) : null,
  };
}

export async function getVisitPricing(
  caller: CallerContext,
  appointmentId: string,
  visitId: string,
  now: Date,
): Promise<PricingResult<VisitPricing>> {
  return withTenant(caller.tenantId, caller.actor, async (tx) => {
    const reached = await reachVisitForOrders(tx, caller, appointmentId, visitId, now, false);
    if (!reached.ok) return { ok: false as const, refusal: reached.refusal };
    return { ok: true as const, value: await view(tx, caller, visitId) };
  });
}

/**
 * Records or clears the adjustment. `adjustmentMinor: null` clears it, and clearing is the only way
 * to undo one — the row is rewritten, not zeroed, because the CHECK refuses a zero adjustment.
 *
 * **The flag is checked here and not in the capability matrix**: the matrix describes roles, and
 * "this doctor may move a price" is a fact about one person that an admin sets on the doctor form.
 */
export async function saveVisitAdjustment(
  caller: CallerContext,
  appointmentId: string,
  visitId: string,
  input: { adjustmentMinor: number | null; reason: string | null },
  now: Date,
): Promise<PricingResult<VisitPricing>> {
  return withTenant(caller.tenantId, caller.actor, async (tx) => {
    const reached = await reachVisitForOrders(tx, caller, appointmentId, visitId, now, true);
    if (!reached.ok) return { ok: false as const, refusal: reached.refusal };

    const permission = await pricingPermission(tx, caller);
    if (!permission.allowed) {
      return {
        ok: false as const,
        refusal: { code: "PRICE_ADJUSTMENT_NOT_ALLOWED" as const, params: {} },
      };
    }

    // **The cap, in either direction.** The trigger refuses this too — this exists so the doctor
    // gets a sentence naming the limit rather than a constraint violation.
    if (input.adjustmentMinor !== null) {
      const cap = capFor(permission, await visitSubtotalMinor(tx, visitId));
      if (cap !== null && Math.abs(input.adjustmentMinor) > cap) {
        return {
          ok: false as const,
          refusal: {
            code: "PRICE_ADJUSTMENT_ABOVE_CAP" as const,
            params: { limit: cap, actual: Math.abs(input.adjustmentMinor) },
          },
        };
      }
    }

    const clearing = input.adjustmentMinor === null;
    const updated = await tx.visit.updateMany({
      where: { id: visitId, ...visitScope(caller) },
      data: clearing
        ? {
            priceAdjustmentMinor: null,
            priceAdjustmentReason: null,
            priceAdjustedByUserId: null,
            priceAdjustedAt: null,
          }
        : {
            priceAdjustmentMinor: input.adjustmentMinor,
            priceAdjustmentReason: input.reason,
            priceAdjustedByUserId: caller.actor.userId,
            priceAdjustedAt: now,
          },
    });
    if (updated.count === 0) {
      return {
        ok: false as const,
        refusal: { code: "NOT_FOUND" as const, params: { resource: "visit" as const } },
      };
    }
    return { ok: true as const, value: await view(tx, caller, visitId) };
  });
}
