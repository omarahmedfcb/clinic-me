// What was done at a visit, and what it cost when it was recorded. Q25.
// Prices are snapshotted on insert and never re-joined: `services.price_minor` is a mutable row.

import { uuidv7 } from "uuidv7";
import type { RefusalParams } from "../../common/refusals.ts";
import { injected } from "../../prisma/injected.ts";
import type { TransactionClient } from "../../prisma/with-tenant.ts";
import { withTenant } from "../../prisma/with-tenant.ts";
import type { CallerContext } from "../appointments/appointments.service.ts";
import {
  isPresentWithDoctor,
  resolveAccess,
  withinAmendmentGrace,
  type ClinicalRefusal,
} from "./clinical.access.ts";
import { visitScope } from "./visit-scope.ts";

export type ProcedureRefusal =
  | ClinicalRefusal
  | { code: "NOT_A_DOCTOR"; params: RefusalParams }
  | { code: "ALREADY_COMPLETED"; params: RefusalParams };

export type ProcedureResult<T> = { ok: true; value: T } | { ok: false; refusal: ProcedureRefusal };

export interface VisitProcedureLine {
  id: string;
  serviceId: string;
  serviceNameAr: string;
  serviceNameEn: string;
  quantity: number;
  /** Minor units, or null meaning no price was recorded. Never rendered as zero. */
  unitPriceMinor: number | null;
  source: "RECEPTION" | "DOCTOR";
  recordedByUserId: string;
  createdAt: Date;
}

const LINE_COLUMNS = {
  id: true,
  serviceId: true,
  quantity: true,
  unitPriceMinor: true,
  source: true,
  recordedByUserId: true,
  createdAt: true,
} as const;

/**
 * The lines on a visit, oldest first, with each service's name resolved.
 *
 * The name is joined; the price is not. `price-snapshot-is-never-rejoined.spec.ts` enforces the
 * difference, and it is the whole reason `unit_price_minor` exists on the row.
 */
export async function listProcedures(
  tx: TransactionClient,
  visitId: string,
): Promise<VisitProcedureLine[]> {
  const rows = await tx.visitProcedure.findMany({
    where: { visitId },
    select: { ...LINE_COLUMNS, service: { select: { nameAr: true, nameEn: true } } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  return rows.map(({ service, ...line }) => ({
    ...line,
    serviceNameAr: service.nameAr,
    serviceNameEn: service.nameEn,
  }));
}

/**
 * The consultation reception already booked, written onto a new visit as its first line.
 *
 * The price comes from `appointments.quoted_price_minor` — what reception actually quoted — and
 * never from the service's current price, which would re-quote a conversation that already happened.
 */
export async function seedReceptionLine(
  tx: TransactionClient,
  userId: string,
  visitId: string,
  appointment: { serviceId: string; quotedPriceMinor: number | null },
): Promise<void> {
  await tx.visitProcedure.create({
    data: injected({
      id: uuidv7(),
      visitId,
      serviceId: appointment.serviceId,
      quantity: 1,
      unitPriceMinor: appointment.quotedPriceMinor,
      source: "RECEPTION",
      recordedByUserId: userId,
    }),
  });
}

/** The caller's own draft for this appointment, with the access checks every clinical write shares. */
async function claimDraft(
  tx: TransactionClient,
  caller: CallerContext,
  appointmentId: string,
  visitId: string,
  now: Date,
): Promise<{ ok: true } | { ok: false; refusal: ProcedureRefusal }> {
  const resolved = await resolveAccess(tx, caller, appointmentId, now);
  if (!resolved.ok) return { ok: false, refusal: resolved.refusal };
  const { access } = resolved;
  if (access.callerDoctorId === null) {
    return { ok: false, refusal: { code: "NOT_A_DOCTOR", params: {} } };
  }
  // Patient-first: the appointment in the path may be finished, and its status then answers the
  // wrong question. The rule is still Q18's — current care or an active grant, never authorship,
  // and not R-B's read door either: claiming a draft is a write.
  if (
    !access.mayWriteClinical &&
    !(await isPresentWithDoctor(tx, access.patientId, access.callerDoctorId))
  ) {
    return { ok: false, refusal: { code: "NOT_PRESENT", params: {} } };
  }

  const visit = await tx.visit.findFirst({
    where: { id: visitId, appointmentId, ...visitScope(caller) },
    select: { status: true },
  });
  if (visit === null) return { ok: false, refusal: { code: "NOT_FOUND", params: { resource: "visit" } } };
  if (visit.status === "COMPLETED") {
    return { ok: false, refusal: { code: "ALREADY_COMPLETED", params: {} } };
  }
  return { ok: true };
}

export async function getProcedures(
  caller: CallerContext,
  appointmentId: string,
  visitId: string,
  now: Date,
): Promise<ProcedureResult<VisitProcedureLine[]>> {
  return withTenant(caller.tenantId, caller.actor, async (tx) => {
    const resolved = await resolveAccess(tx, caller, appointmentId, now);
    if (!resolved.ok) return { ok: false as const, refusal: resolved.refusal };
    const { access } = resolved;
    const visit = await tx.visit.findFirst({
      where: { id: visitId, appointmentId, ...visitScope(caller) },
      select: { id: true, doctorId: true, completedAt: true },
    });
    // Q6's window applies to reading a finished visit's lines too: the screen keeps showing them
    // for as long as the doctor who finished it may still correct it (D35).
    if (
      visit !== null &&
      !access.mayReadFullHistory &&
      !withinAmendmentGrace(access.callerDoctorId, visit, now) &&
      !(
        access.callerDoctorId !== null &&
        (await isPresentWithDoctor(tx, access.patientId, access.callerDoctorId))
      )
    ) {
      return { ok: false as const, refusal: { code: "NOT_PRESENT" as const, params: {} } };
    }
    if (visit === null) {
      return { ok: false as const, refusal: { code: "NOT_FOUND" as const, params: { resource: "visit" as const } } };
    }
    return { ok: true as const, value: await listProcedures(tx, visitId) };
  });
}

/** Add a service the doctor performed. The price is read at its root and copied onto the row. */
export async function addProcedure(
  caller: CallerContext,
  appointmentId: string,
  visitId: string,
  input: { serviceId: string; quantity: number },
  now: Date,
): Promise<ProcedureResult<VisitProcedureLine[]>> {
  return withTenant(caller.tenantId, caller.actor, async (tx) => {
    const claimed = await claimDraft(tx, caller, appointmentId, visitId, now);
    if (!claimed.ok) return { ok: false as const, refusal: claimed.refusal };

    const service = await tx.service.findFirst({
      where: { id: input.serviceId, isActive: true },
      select: { priceMinor: true },
    });
    if (service === null) {
      return { ok: false as const, refusal: { code: "NOT_FOUND" as const, params: { resource: "service" as const } } };
    }

    await tx.visitProcedure.create({
      data: injected({
        id: uuidv7(),
        visitId,
        serviceId: input.serviceId,
        quantity: input.quantity,
        unitPriceMinor: service.priceMinor,
        source: "DOCTOR",
        recordedByUserId: caller.actor.userId,
      }),
    });
    return { ok: true as const, value: await listProcedures(tx, visitId) };
  });
}

/**
 * Remove a line the doctor added, and only while the visit is a draft.
 *
 * Not a breach of "medical and financial records are never hard-deleted": nothing has been recorded
 * until the visit completes, so this is the same act as deleting a sentence that was mistyped. A
 * completed visit refuses it, and reception's own consultation line is never removable at all.
 */
export async function removeProcedure(
  caller: CallerContext,
  appointmentId: string,
  visitId: string,
  procedureId: string,
  now: Date,
): Promise<ProcedureResult<VisitProcedureLine[]>> {
  return withTenant(caller.tenantId, caller.actor, async (tx) => {
    const claimed = await claimDraft(tx, caller, appointmentId, visitId, now);
    if (!claimed.ok) return { ok: false as const, refusal: claimed.refusal };

    const removed = await tx.visitProcedure.deleteMany({
      where: { id: procedureId, visitId, source: "DOCTOR" },
    });
    if (removed.count === 0) {
      return { ok: false as const, refusal: { code: "NOT_FOUND" as const, params: { resource: "procedure" as const } } };
    }
    return { ok: true as const, value: await listProcedures(tx, visitId) };
  });
}
