// Finishing a visit, and correcting a finished one. Q6, and Q24's follow-up appointment.
// One act: the visit completes and the appointment completes in the same transaction.

import { uuidv7 } from "uuidv7";
import { Prisma } from "../../generated/prisma/client.ts";
import type { RefusalParams } from "../../common/refusals.ts";
import { injected } from "../../prisma/injected.ts";
import { withTenant, type TransactionClient } from "../../prisma/with-tenant.ts";
import type { CallerContext } from "../appointments/appointments.service.ts";
import { loadContext, loadDayInput } from "../appointments/appointments.fetch.ts";
import { generateSlots } from "../appointments/domain/generate-slots.ts";
import { addDays, calendarDayIn } from "../appointments/domain/zoned-time.ts";
import { completeAppointmentInTx } from "../queue/queue.moves.ts";
import { recordNotification } from "../notifications/notifications.service.ts";
import {
  isPresentWithDoctor,
  resolveAccess,
  withinAmendmentGrace,
  type ClinicalRefusal,
} from "./clinical.access.ts";
import { visitScope } from "./visit-scope.ts";
import { writeChargeForVisit } from "../billing/charge-from-visit.ts";

export type CompletionRefusal =
  | ClinicalRefusal
  | { code: "NOT_A_DOCTOR"; params: RefusalParams }
  | { code: "STALE_REVISION"; params: RefusalParams }
  | { code: "ALREADY_COMPLETED"; params: RefusalParams }
  | { code: "NOT_COMPLETED"; params: RefusalParams }
  | { code: "REASON_REQUIRED"; params: RefusalParams }
  | { code: "ILLEGAL_TRANSITION"; params: RefusalParams }
  | { code: "TERMINAL_STATUS"; params: RefusalParams }
  | { code: "QUEUE_MOVED_ON"; params: RefusalParams }
  | { code: "MISSING_CONTEXT"; params: RefusalParams }
  | { code: "GRACE_PERIOD_NOT_ELAPSED"; params: RefusalParams };

export type CompletionResult<T> = { ok: true; value: T } | { ok: false; refusal: CompletionRefusal };

export interface CompletedVisit {
  visitId: string;
  revision: number;
  completedAt: Date;
  appointmentStatus: string;
  /** The date a follow-up was asked for, or null when none was. */
  followUpDate: string | null;
  /**
   * The appointment the follow-up became, or null when the requested day had no free slot. Null is
   * an answer the screen must show — reception books it — never a silent failure.
   */
  followUpAppointmentId: string | null;
}

export interface CompleteInput {
  expectedRevision: number;
  followUpDate?: string;
  followUpIntervalDays?: number;
}

const INDEX = "visits_one_completed_per_appointment";

/** Postgres refusing a second COMPLETED visit for one appointment — the partial unique index. */
function isSecondCompletedVisit(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    `${JSON.stringify(error.meta ?? {})} ${error.message}`.includes(INDEX)
  );
}

export async function completeVisit(
  caller: CallerContext,
  appointmentId: string,
  visitId: string,
  input: CompleteInput,
  now: Date,
): Promise<CompletionResult<CompletedVisit>> {
  try {
    return await withTenant(caller.tenantId, caller.actor, async (tx) => {
      const resolved = await resolveAccess(tx, caller, appointmentId, now);
      if (!resolved.ok) return { ok: false as const, refusal: resolved.refusal };
      const { access } = resolved;
      if (access.callerDoctorId === null) {
        return { ok: false as const, refusal: { code: "NOT_A_DOCTOR" as const, params: {} } };
      }
      if (!access.mayWriteClinical) {
        return { ok: false as const, refusal: { code: "NOT_PRESENT" as const, params: {} } };
      }

      const appointment = await tx.appointment.findFirst({
        where: { id: appointmentId },
        select: { doctorId: true, serviceId: true, patientId: true },
      });
      if (appointment === null) {
        return {
          ok: false as const,
          refusal: { code: "NOT_FOUND" as const, params: { resource: "appointment" as const } },
        };
      }

      const followUp = await resolveFollowUpDate(tx, caller.tenantId, input, now);

      // Compare-and-set, exactly as an autosave is: completing from a screen whose text is one
      // revision behind is the same lost write, and it must be refused the same way.
      const claimed = await tx.visit.updateMany({
        where: {
          id: visitId,
          appointmentId,
          status: "DRAFT",
          revision: input.expectedRevision,
          ...visitScope(caller),
        },
        data: {
          status: "COMPLETED",
          completedAt: now,
          followUpDate: followUp === null ? null : new Date(`${followUp}T00:00:00.000Z`),
          followUpIntervalDays: input.followUpIntervalDays ?? null,
          revision: { increment: 1 },
        },
      });

      if (claimed.count === 0) {
        const current = await tx.visit.findFirst({
          where: { id: visitId, appointmentId, ...visitScope(caller) },
          select: { status: true, revision: true },
        });
        if (current === null) {
          return {
            ok: false as const,
            refusal: { code: "NOT_FOUND" as const, params: { resource: "visit" as const } },
          };
        }
        if (current.status === "COMPLETED") {
          return { ok: false as const, refusal: { code: "ALREADY_COMPLETED" as const, params: {} } };
        }
        return {
          ok: false as const,
          refusal: { code: "STALE_REVISION" as const, params: { revision: current.revision } },
        };
      }

      const appointmentDone = await completeAppointmentInTx(tx, caller, appointmentId, now);
      if (!appointmentDone.ok) {
        const { code, params } = appointmentDone;
        return { ok: false as const, refusal: { code, params } as CompletionRefusal };
      }

      // Phase 5 PR 4: the charge is written inside the completing transaction, so a visit that is
      // COMPLETED always has one. Writing it afterwards would leave a window in which a completed
      // visit has nothing to bill, and that window is exactly when reception asks for the money.
      await writeChargeForVisit(tx, visitId, appointment.patientId, appointmentId, caller);

      const booked =
        followUp === null
          ? null
          : await bookFollowUp(tx, caller, {
              patientId: appointment.patientId,
              doctorId: appointment.doctorId,
              serviceId: appointment.serviceId,
              date: followUp,
              now,
            });

      const saved = await tx.visit.findFirst({
        where: { id: visitId, ...visitScope(caller) },
        select: { revision: true, completedAt: true },
      });

      return {
        ok: true as const,
        value: {
          visitId,
          revision: saved?.revision ?? input.expectedRevision + 1,
          completedAt: saved?.completedAt ?? now,
          appointmentStatus: appointmentDone.status,
          followUpDate: followUp,
          followUpAppointmentId: booked,
        },
      };
    });
  } catch (error) {
    // The database is the arbiter of "one completed visit per appointment"; the service never
    // pre-checks, because a pre-check races with the client that lost.
    if (isSecondCompletedVisit(error)) {
      return { ok: false, refusal: { code: "ALREADY_COMPLETED", params: {} } };
    }
    throw error;
  }
}

/** The follow-up's day, from an explicit date or an interval counted in the clinic's own zone. */
async function resolveFollowUpDate(
  tx: TransactionClient,
  tenantId: string,
  input: CompleteInput,
  now: Date,
): Promise<string | null> {
  if (input.followUpDate !== undefined) return input.followUpDate;
  if (input.followUpIntervalDays === undefined) return null;
  const tenant = await tx.tenant.findUnique({ where: { id: tenantId }, select: { timezone: true } });
  if (tenant === null) return null;
  return addDays(calendarDayIn(now, tenant.timezone), input.followUpIntervalDays);
}

/**
 * Book the follow-up into the first free slot on the requested day, or report that there was none.
 *
 * Availability comes from the same engine every other booking path uses (ARCHITECTURE.md §12), so
 * there is no second notion of what is free. When the day is full the visit still completes and
 * this returns null: a doctor mid-consultation cannot be made to negotiate a diary.
 */
async function bookFollowUp(
  tx: TransactionClient,
  caller: CallerContext,
  input: { patientId: string; doctorId: string; serviceId: string; date: string; now: Date },
): Promise<string | null> {
  const context = await loadContext(tx, caller.tenantId, input.doctorId, input.serviceId);
  if (!context.ok) return null;

  const slots = generateSlots({
    ...(await loadDayInput(tx, input.doctorId, input.date, context.timezone)),
    service: { durationMinutes: context.durationMinutes, bufferMinutes: context.bufferMinutes },
    granularityMinutes: context.tenant.slotGranularityMinutes,
    leadMinutes: context.tenant.bookingLeadMinutesStaff,
    now: input.now,
  });
  const slot = slots[0];
  if (slot === undefined) return null;

  const service = await tx.service.findFirst({
    where: { id: input.serviceId },
    select: { priceMinor: true },
  });

  const created = await tx.appointment.create({
    data: injected({
      id: uuidv7(),
      patientId: input.patientId,
      doctorId: input.doctorId,
      serviceId: input.serviceId,
      quotedPriceMinor: service?.priceMinor ?? null,
      scheduledStart: slot.start,
      scheduledEnd: slot.end,
      status: "BOOKED",
      source: "DOCTOR",
      createdBy: caller.actor.userId,
      updatedBy: caller.actor.userId,
    }),
  });

  await tx.appointmentEvent.create({
    data: injected({
      id: uuidv7(),
      appointmentId: created.id,
      eventType: "CREATED",
      fromStatus: null,
      toStatus: "BOOKED",
      toScheduledStart: created.scheduledStart,
      actorUserId: caller.actor.userId,
    }),
  });

  const patient = await tx.patient.findFirst({
    where: { id: input.patientId },
    select: { fullNameAr: true },
  });
  await recordNotification(tx, caller.actor.userId, {
    kind: "APPOINTMENT_BOOKED",
    appointmentId: created.id,
    patientId: input.patientId,
    source: "DOCTOR",
    occurredAt: input.now,
    payload: {
      patientName: patient?.fullNameAr ?? "",
      start: created.scheduledStart.toISOString(),
    },
  });

  return created.id;
}

/**
 * May this caller write to a record whose own appointment is over?
 *
 * Asked patient-first, which is the distinction `isPresentWithDoctor` was extracted for: the
 * appointment in the URL is a finished one, so its status answers the wrong question. The rule is
 * still Q18's — current care or an active grant, never authorship — and R-B's read door adds none:
 * correcting a record is a write, and a past patient of one's own opens reading only.
 */
async function mayCorrectRecord(
  tx: TransactionClient,
  access: { callerDoctorId: string | null; patientId: string; mayWriteClinical: boolean },
  visit: { doctorId: string; completedAt: Date | null },
  now: Date,
): Promise<boolean> {
  if (access.mayWriteClinical) return true;
  if (access.callerDoctorId === null) return false;
  // Q6's 24-hour window, and only for the doctor who completed it (D35).
  if (withinAmendmentGrace(access.callerDoctorId, visit, now)) return true;
  return isPresentWithDoctor(tx, access.patientId, access.callerDoctorId);
}

/** The fields an amendment may correct — the clinical text, and nothing structural. */
export const AMENDABLE = [
  "complaint",
  "medicalHistory",
  "examination",
  "diagnosis",
  "treatmentPlan",
  "doctorNotes",
] as const;

export type AmendableField = (typeof AMENDABLE)[number];

export interface AmendInput {
  reason: string;
  changes: Partial<Record<AmendableField, string>>;
}

/**
 * Correct a completed visit — a reason, a `visit_revisions` row, and the original preserved (Q6).
 *
 * The revision row is written before the update, from values read in the same transaction, so a
 * correction that commits without its history is not a state this can reach.
 */
export async function amendVisit(
  caller: CallerContext,
  appointmentId: string,
  visitId: string,
  input: AmendInput,
  now: Date,
): Promise<CompletionResult<{ visitId: string; revision: number }>> {
  return withTenant(caller.tenantId, caller.actor, async (tx) => {
    const resolved = await resolveAccess(tx, caller, appointmentId, now);
    if (!resolved.ok) return { ok: false as const, refusal: resolved.refusal };
    if (resolved.access.callerDoctorId === null) {
      return { ok: false as const, refusal: { code: "NOT_A_DOCTOR" as const, params: {} } };
    }

    // Loaded before the access decision, because the grace window is a fact about *this visit* —
    // who finished it and when — and cannot be answered from the appointment alone.
    const visit = await tx.visit.findFirst({
      where: { id: visitId, appointmentId, ...visitScope(caller) },
      select: {
        status: true,
        revision: true,
        doctorId: true,
        completedAt: true,
        complaint: true,
        medicalHistory: true,
        examination: true,
        diagnosis: true,
        treatmentPlan: true,
        doctorNotes: true,
      },
    });
    if (visit === null) {
      return {
        ok: false as const,
        refusal: { code: "NOT_FOUND" as const, params: { resource: "visit" as const } },
      };
    }
    if (!(await mayCorrectRecord(tx, resolved.access, visit, now))) {
      return { ok: false as const, refusal: { code: "NOT_PRESENT" as const, params: {} } };
    }
    if (input.reason.trim() === "") {
      return { ok: false as const, refusal: { code: "REASON_REQUIRED" as const, params: {} } };
    }
    if (visit.status !== "COMPLETED") {
      return { ok: false as const, refusal: { code: "NOT_COMPLETED" as const, params: {} } };
    }

    const changed = AMENDABLE.filter(
      (field) => input.changes[field] !== undefined && input.changes[field] !== visit[field],
    );
    if (changed.length === 0) {
      return { ok: true as const, value: { visitId, revision: visit.revision } };
    }

    await tx.visitRevision.create({
      data: injected({
        id: uuidv7(),
        visitId,
        changedFields: changed,
        previousValues: Object.fromEntries(changed.map((field) => [field, visit[field]])),
        actorUserId: caller.actor.userId,
        reason: input.reason,
      }),
    });

    const updated = await tx.visit.update({
      where: { id: visitId },
      data: {
        ...Object.fromEntries(changed.map((field) => [field, input.changes[field]])),
        revision: { increment: 1 },
      },
      select: { revision: true },
    });

    return { ok: true as const, value: { visitId, revision: updated.revision } };
  });
}
