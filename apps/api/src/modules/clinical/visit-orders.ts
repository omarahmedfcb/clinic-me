// What a visit orders: the prescription and the investigations requested. Q8, Q9's data half, Q24.
// Both are replaced whole while the visit is a draft, and frozen once it completes.

import { uuidv7 } from "uuidv7";
import type { RefusalParams } from "../../common/refusals.ts";
import { injected } from "../../prisma/injected.ts";
import { withTenant, type TransactionClient } from "../../prisma/with-tenant.ts";
import type { CallerContext } from "../appointments/appointments.service.ts";
import {
  isPresentWithDoctor,
  resolveAccess,
  withinAmendmentGrace,
  type ClinicalRefusal,
} from "./clinical.access.ts";
import { visitScope } from "./visit-scope.ts";

export type OrdersRefusal =
  | ClinicalRefusal
  | { code: "NOT_A_DOCTOR"; params: RefusalParams }
  | { code: "ALREADY_COMPLETED"; params: RefusalParams };

export type OrdersResult<T> = { ok: true; value: T } | { ok: false; refusal: OrdersRefusal };

export interface PrescriptionLine {
  medicationName: string;
  /** Q45: strength and form identify the product; quantity is what the pharmacist dispenses. */
  strength: string | null;
  form: string | null;
  quantity: string | null;
  dose: string;
  frequency: string;
  duration: string;
  instructions: string | null;
}

export interface VisitPrescription {
  prescriptionId: string | null;
  notes: string | null;
  items: PrescriptionLine[];
  printedCount: number;
}

export interface InvestigationLine {
  name: string;
  notes: string | null;
}

export interface VisitInvestigations {
  freeText: string | null;
  items: InvestigationLine[];
}

/** Access for a visit's orders: the doctor, and the patient with them now or under a grant. */
/**
 * The access rules every order on a visit shares: a doctor, reachable patient, and a draft when
 * the caller intends to write. Exported for `sick-leave.ts`, which is the same kind of thing --
 * duplicating these rules would be a second copy of Q6 and Q18 to keep in step.
 */
export async function reachVisitForOrders(
  tx: TransactionClient,
  caller: CallerContext,
  appointmentId: string,
  visitId: string,
  now: Date,
  needDraft: boolean,
): Promise<{ ok: true } | { ok: false; refusal: OrdersRefusal }> {
  const resolved = await resolveAccess(tx, caller, appointmentId, now);
  if (!resolved.ok) return { ok: false, refusal: resolved.refusal };
  const { access } = resolved;
  if (access.callerDoctorId === null) {
    return { ok: false, refusal: { code: "NOT_A_DOCTOR", params: {} } };
  }

  const visit = await tx.visit.findFirst({
    where: { id: visitId, appointmentId, ...visitScope(caller) },
    select: { status: true, doctorId: true, completedAt: true },
  });
  if (visit === null) return { ok: false, refusal: { code: "NOT_FOUND", params: { resource: "visit" } } };

  // Patient-first, because the appointment in the path may be finished and its status then answers
  // the wrong question — plus Q6's 24-hour window for the doctor who finished it (D35), which is
  // what lets a prescription be printed in the minute after the visit ends.
  //
  // Which flag depends on the intent: `needDraft` means an order is about to be written, and R-B's
  // read door must not reach a write. Reading a past prescription of one's own patient is exactly
  // what that door is for.
  const allowed = needDraft ? access.mayWriteClinical : access.mayReadFullHistory;
  if (
    !allowed &&
    !withinAmendmentGrace(access.callerDoctorId, visit, now) &&
    !(await isPresentWithDoctor(tx, access.patientId, access.callerDoctorId))
  ) {
    return { ok: false, refusal: { code: "NOT_PRESENT", params: {} } };
  }

  if (needDraft && visit.status === "COMPLETED") {
    return { ok: false, refusal: { code: "ALREADY_COMPLETED", params: {} } };
  }
  return { ok: true };
}

async function readPrescription(
  tx: TransactionClient,
  visitId: string,
): Promise<VisitPrescription> {
  const row = await tx.prescription.findFirst({
    where: { visitId },
    select: {
      id: true,
      notes: true,
      printedCount: true,
      items: {
        select: {
          medicationName: true,
          strength: true,
          form: true,
          quantity: true,
          dose: true,
          frequency: true,
          duration: true,
          instructions: true,
        },
        orderBy: { sortOrder: "asc" },
      },
    },
  });
  return {
    prescriptionId: row?.id ?? null,
    notes: row?.notes ?? null,
    items: row?.items ?? [],
    printedCount: row?.printedCount ?? 0,
  };
}

export async function getPrescription(
  caller: CallerContext,
  appointmentId: string,
  visitId: string,
  now: Date,
): Promise<OrdersResult<VisitPrescription>> {
  return withTenant(caller.tenantId, caller.actor, async (tx) => {
    const reached = await reachVisitForOrders(tx, caller, appointmentId, visitId, now, false);
    if (!reached.ok) return { ok: false as const, refusal: reached.refusal };
    return { ok: true as const, value: await readPrescription(tx, visitId) };
  });
}

/**
 * Replace the visit's prescription with the lines given, while the visit is still a draft.
 *
 * Replaced whole rather than patched line by line, because the doctor edits a list on a screen and
 * a per-line protocol would make the client reconcile two orderings. `sort_order` is the list's
 * own order, which Q8 notes is a requirement hiding in a column.
 */
export async function savePrescription(
  caller: CallerContext,
  appointmentId: string,
  visitId: string,
  input: { notes?: string | null; items: PrescriptionLine[] },
  now: Date,
): Promise<OrdersResult<VisitPrescription>> {
  return withTenant(caller.tenantId, caller.actor, async (tx) => {
    const reached = await reachVisitForOrders(tx, caller, appointmentId, visitId, now, true);
    if (!reached.ok) return { ok: false as const, refusal: reached.refusal };

    const visit = await tx.visit.findFirst({
      where: { id: visitId, ...visitScope(caller) },
      select: { patientId: true, doctorId: true },
    });
    if (visit === null) {
      return { ok: false as const, refusal: { code: "NOT_FOUND" as const, params: { resource: "visit" as const } } };
    }

    const existing = await tx.prescription.findFirst({ where: { visitId }, select: { id: true } });
    const prescriptionId = existing?.id ?? uuidv7();

    if (existing === null) {
      await tx.prescription.create({
        data: injected({
          id: prescriptionId,
          visitId,
          patientId: visit.patientId,
          doctorId: visit.doctorId,
          issuedAt: now,
          notes: input.notes ?? null,
        }),
      });
    } else {
      await tx.prescription.update({
        where: { id: prescriptionId },
        data: { notes: input.notes ?? null },
      });
      // Lines on an unfinished visit are not yet a record: this is the same act as retyping a list
      // on the screen. A completed visit never reaches here — `reach` refuses it above.
      await tx.prescriptionItem.deleteMany({ where: { prescriptionId } });
    }

    for (const [index, item] of input.items.entries()) {
      await tx.prescriptionItem.create({
        data: injected({
          id: uuidv7(),
          prescriptionId,
          medicationName: item.medicationName,
          strength: item.strength ?? null,
          form: item.form ?? null,
          quantity: item.quantity ?? null,
          dose: item.dose,
          frequency: item.frequency,
          duration: item.duration,
          instructions: item.instructions ?? null,
          sortOrder: index,
        }),
      });
    }

    return { ok: true as const, value: await readPrescription(tx, visitId) };
  });
}

/**
 * Count one printing of this visit's prescription — Q9.
 *
 * A counter, not a log: Q9 rules that printing is the delivery mechanism and that nothing
 * patient-facing is built for it, so what is worth knowing is that a sheet exists in the world.
 * There is no draft requirement — a finished visit is exactly what gets printed.
 */
export async function recordPrescriptionPrinted(
  caller: CallerContext,
  appointmentId: string,
  visitId: string,
  now: Date,
): Promise<OrdersResult<VisitPrescription>> {
  return withTenant(caller.tenantId, caller.actor, async (tx) => {
    const reached = await reachVisitForOrders(tx, caller, appointmentId, visitId, now, false);
    if (!reached.ok) return { ok: false as const, refusal: reached.refusal };

    const updated = await tx.prescription.updateMany({
      where: { visitId },
      data: { printedCount: { increment: 1 } },
    });
    if (updated.count === 0) {
      // Nothing to print. Saying so beats reporting a successful print of a sheet with no lines.
      return { ok: false as const, refusal: { code: "NOT_FOUND" as const, params: { resource: "visit" as const } } };
    }
    return { ok: true as const, value: await readPrescription(tx, visitId) };
  });
}

async function readInvestigations(
  tx: TransactionClient,
  caller: CallerContext,
  visitId: string,
): Promise<VisitInvestigations> {
  const [visit, items] = await Promise.all([
    tx.visit.findFirst({
      where: { id: visitId, ...visitScope(caller) },
      select: { investigations: true },
    }),
    tx.visitInvestigation.findMany({
      where: { visitId },
      select: { name: true, notes: true },
      orderBy: { sortOrder: "asc" },
    }),
  ]);
  return { freeText: visit?.investigations ?? null, items };
}

export async function getInvestigations(
  caller: CallerContext,
  appointmentId: string,
  visitId: string,
  now: Date,
): Promise<OrdersResult<VisitInvestigations>> {
  return withTenant(caller.tenantId, caller.actor, async (tx) => {
    const reached = await reachVisitForOrders(tx, caller, appointmentId, visitId, now, false);
    if (!reached.ok) return { ok: false as const, refusal: reached.refusal };
    return { ok: true as const, value: await readInvestigations(tx, caller, visitId) };
  });
}

export async function saveInvestigations(
  caller: CallerContext,
  appointmentId: string,
  visitId: string,
  input: { freeText?: string | null; items: InvestigationLine[] },
  now: Date,
): Promise<OrdersResult<VisitInvestigations>> {
  return withTenant(caller.tenantId, caller.actor, async (tx) => {
    const reached = await reachVisitForOrders(tx, caller, appointmentId, visitId, now, true);
    if (!reached.ok) return { ok: false as const, refusal: reached.refusal };

    await tx.visit.updateMany({
      where: { id: visitId, status: "DRAFT", ...visitScope(caller) },
      data: { investigations: input.freeText ?? null },
    });
    await tx.visitInvestigation.deleteMany({ where: { visitId } });
    for (const [index, item] of input.items.entries()) {
      await tx.visitInvestigation.create({
        data: injected({
          id: uuidv7(),
          visitId,
          name: item.name,
          notes: item.notes ?? null,
          sortOrder: index,
        }),
      });
    }

    return { ok: true as const, value: await readInvestigations(tx, caller, visitId) };
  });
}

/**
 * Medications this clinic has prescribed before, for the autocomplete Q8 rules. Q8, and PR 6.
 *
 * **Matched on the stored text, byte for byte.** The Arabic normalisation written for patient-name
 * search is deliberately not reused: clinical free text is stored and searched byte-identical, and
 * a normaliser that folds hamza and alef in a drug name would silently merge two different drugs.
 * Case is folded, because Latin drug names are typed in either case and that is not a clinical
 * distinction.
 *
 * No dictionary, no external source, and no claim that the list is complete or safe.
 */
export async function suggestMedications(
  caller: CallerContext,
  query: string,
  limit = 10,
): Promise<string[]> {
  const trimmed = query.trim();
  if (trimmed === "") return [];
  return withTenant(caller.tenantId, caller.actor, async (tx) => {
    const rows = await tx.prescriptionItem.findMany({
      where: { medicationName: { contains: trimmed, mode: "insensitive" } },
      select: { medicationName: true },
      distinct: ["medicationName"],
      orderBy: { medicationName: "asc" },
      take: limit,
    });
    return rows.map((row) => row.medicationName);
  });
}
