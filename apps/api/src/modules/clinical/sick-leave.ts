// Sick leave on the visit — Q46. Same access rules and the same print count as the prescription,
// because it is the same kind of thing: a document this visit issues on the clinic's letterhead.

import { withTenant } from "../../prisma/with-tenant.ts";
import type { CallerContext } from "../appointments/appointments.service.ts";
import { reachVisitForOrders, type OrdersResult } from "./visit-orders.ts";
import { visitScope } from "./visit-scope.ts";

export interface SickLeave {
  /** Null when no certificate has been recorded, which is the ordinary case. */
  days: number | null;
  /** ISO calendar day. Stored as a DATE: leave starts on a day, not at an instant. */
  from: string | null;
  note: string | null;
  printedCount: number;
}

const EMPTY: SickLeave = { days: null, from: null, note: null, printedCount: 0 };

function view(row: {
  sickLeaveDays: number | null;
  sickLeaveFrom: Date | null;
  sickLeaveNote: string | null;
  sickLeavePrintedCount: number;
}): SickLeave {
  return {
    days: row.sickLeaveDays,
    // `toISOString().slice(0, 10)` and not a locale format: this is a calendar day travelling as
    // text, and the client formats it. A DATE column comes back at UTC midnight.
    from: row.sickLeaveFrom === null ? null : row.sickLeaveFrom.toISOString().slice(0, 10),
    note: row.sickLeaveNote,
    printedCount: row.sickLeavePrintedCount,
  };
}

const COLUMNS = {
  sickLeaveDays: true,
  sickLeaveFrom: true,
  sickLeaveNote: true,
  sickLeavePrintedCount: true,
} as const;

export async function getSickLeave(
  caller: CallerContext,
  appointmentId: string,
  visitId: string,
  now: Date,
): Promise<OrdersResult<SickLeave>> {
  return withTenant(caller.tenantId, caller.actor, async (tx) => {
    const reached = await reachVisitForOrders(tx, caller, appointmentId, visitId, now, false);
    if (!reached.ok) return { ok: false as const, refusal: reached.refusal };

    const visit = await tx.visit.findFirst({
      where: { id: visitId, ...visitScope(caller) },
      select: COLUMNS,
    });
    return { ok: true as const, value: visit === null ? EMPTY : view(visit) };
  });
}

/**
 * Records or clears the certificate. `days: null` clears all three, which is how a doctor undoes
 * one — the check constraints refuse a half-written certificate, so they move together or not at all.
 */
export async function saveSickLeave(
  caller: CallerContext,
  appointmentId: string,
  visitId: string,
  input: { days: number | null; from: string | null; note: string | null },
  now: Date,
): Promise<OrdersResult<SickLeave>> {
  return withTenant(caller.tenantId, caller.actor, async (tx) => {
    const reached = await reachVisitForOrders(tx, caller, appointmentId, visitId, now, true);
    if (!reached.ok) return { ok: false as const, refusal: reached.refusal };

    const clearing = input.days === null;
    const updated = await tx.visit.updateMany({
      where: { id: visitId, ...visitScope(caller) },
      data: clearing
        ? { sickLeaveDays: null, sickLeaveFrom: null, sickLeaveNote: null }
        : {
            sickLeaveDays: input.days,
            // `${from}T00:00:00Z` so a DATE column receives the day the doctor picked rather than
            // that day shifted by the server's offset.
            sickLeaveFrom: input.from === null ? null : new Date(`${input.from}T00:00:00.000Z`),
            sickLeaveNote: input.note,
          },
    });
    if (updated.count === 0) {
      return { ok: false as const, refusal: { code: "NOT_FOUND" as const, params: { resource: "visit" as const } } };
    }

    const visit = await tx.visit.findFirstOrThrow({
      where: { id: visitId, ...visitScope(caller) },
      select: COLUMNS,
    });
    return { ok: true as const, value: view(visit) };
  });
}

/**
 * The print count, incremented like the prescription's.
 *
 * Refuses when there is no certificate: reporting a successful print of a sheet that says nothing
 * is worse than saying there was nothing to print (the rule `recordPrescriptionPrinted` follows).
 */
export async function recordSickLeavePrinted(
  caller: CallerContext,
  appointmentId: string,
  visitId: string,
  now: Date,
): Promise<OrdersResult<SickLeave>> {
  return withTenant(caller.tenantId, caller.actor, async (tx) => {
    const reached = await reachVisitForOrders(tx, caller, appointmentId, visitId, now, false);
    if (!reached.ok) return { ok: false as const, refusal: reached.refusal };

    const updated = await tx.visit.updateMany({
      where: { id: visitId, sickLeaveDays: { not: null }, ...visitScope(caller) },
      data: { sickLeavePrintedCount: { increment: 1 } },
    });
    if (updated.count === 0) {
      return { ok: false as const, refusal: { code: "NOT_FOUND" as const, params: { resource: "visit" as const } } };
    }

    const visit = await tx.visit.findFirstOrThrow({
      where: { id: visitId, ...visitScope(caller) },
      select: COLUMNS,
    });
    return { ok: true as const, value: view(visit) };
  });
}
