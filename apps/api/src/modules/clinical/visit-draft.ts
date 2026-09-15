// The visit write path: open a draft, and autosave into it under compare-and-set. Q2, Q4, Q7, Q17.
// No completion here — finishing a visit is Q6 and arrives with PR 4.

import { uuidv7 } from "uuidv7";
import { Prisma } from "../../generated/prisma/client.ts";
import type { RefusalParams } from "../../common/refusals.ts";
import { injected } from "../../prisma/injected.ts";
import { withTenant } from "../../prisma/with-tenant.ts";
import type { CallerContext } from "../appointments/appointments.service.ts";
import { resolveAccess, type ClinicalRefusal } from "./clinical.access.ts";
import { isAbandoned } from "./draft-abandonment.ts";
import { seedReceptionLine } from "./visit-procedures.ts";
import { visitScope } from "./visit-scope.ts";

export type DraftRefusal =
  | ClinicalRefusal
  | { code: "NOT_A_DOCTOR"; params: RefusalParams }
  | { code: "STALE_REVISION"; params: RefusalParams };

export type DraftResult<T> = { ok: true; value: T } | { ok: false; refusal: DraftRefusal };

export interface VisitDraft {
  id: string;
  appointmentId: string;
  /** Whose visit this is. The print sheets need it to name the doctor who signs them (Q28). */
  doctorId: string;
  revision: number;
  /** Whatever the client last saved. Shape is the client's (domain/vitals.ts), not the schema's. */
  vitals: unknown;
  complaint: string | null;
  medicalHistory: string | null;
  examination: string | null;
  diagnosis: string | null;
  treatmentPlan: string | null;
  doctorNotes: string | null;
  updatedAt: Date;
  /** True when this draft already existed, so the screen can say it is resuming one (Q4). */
  resumed: boolean;
  /** Derived on read against the instant passed in, never stored (Q15). */
  abandoned: boolean;
  /** Sent on open only. Head circumference is a paediatric field, so the screen needs the age. */
  patientDateOfBirth?: Date | null;
  /** The last completed visit's vitals, so this visit's numbers can be read as a trend (PR 7b). */
  previousVitals?: unknown;
}

const DRAFT_COLUMNS = {
  id: true,
  appointmentId: true,
  doctorId: true,
  revision: true,
  complaint: true,
  medicalHistory: true,
  examination: true,
  diagnosis: true,
  treatmentPlan: true,
  doctorNotes: true,
  vitals: true,
  updatedAt: true,
} as const;

/** The fields a save may set. Nothing here decides status, which is Q6's alone. */
export interface DraftPatch {
  /** Per-visit measurements. Units are fixed by the client and never stored (PR 7b). */
  vitals?: Record<string, number> | null;
  complaint?: string | null;
  medicalHistory?: string | null;
  examination?: string | null;
  diagnosis?: string | null;
  treatmentPlan?: string | null;
  doctorNotes?: string | null;
}

/**
 * Open the caller's draft for an appointment, creating one only if they have none.
 *
 * Idempotent per author, which is what makes Q17 work: two tabs on one visit resume the same row
 * rather than racing to create two. A second doctor calling this gets their own draft, never this one.
 */
export async function openDraft(
  caller: CallerContext,
  appointmentId: string,
  now: Date,
): Promise<DraftResult<VisitDraft>> {
  return withTenant(caller.tenantId, caller.actor, async (tx) => {
    const resolved = await resolveAccess(tx, caller, appointmentId, now);
    if (!resolved.ok) return { ok: false as const, refusal: resolved.refusal };
    const { access } = resolved;

    if (access.callerDoctorId === null) {
      return { ok: false as const, refusal: { code: "NOT_A_DOCTOR" as const, params: {} } };
    }
    if (!access.mayWriteClinical) {
      return { ok: false as const, refusal: { code: "NOT_PRESENT" as const, params: {} } };
    }

    const [patient, previous] = await Promise.all([
      tx.patient.findUnique({
        where: { id: access.patientId },
        select: { dateOfBirth: true },
      }),
      // The last finished visit, for the trend. Scoped like every other read of `visits`.
      tx.visit.findFirst({
        where: { patientId: access.patientId, status: "COMPLETED", ...visitScope(caller) },
        select: { vitals: true },
        orderBy: [{ completedAt: "desc" }, { createdAt: "desc" }],
      }),
    ]);
    const context = {
      patientDateOfBirth: patient?.dateOfBirth ?? null,
      previousVitals: previous?.vitals ?? null,
    };

    const existing = await tx.visit.findFirst({
      where: { appointmentId, status: "DRAFT", ...visitScope(caller) },
      select: DRAFT_COLUMNS,
    });
    if (existing !== null) {
      return {
        ok: true as const,
        // Derived here against `now`, which the caller passed in — never stored, so it cannot go
        // stale and no sweep has to run for it to be right (Q15).
        value: {
          ...existing,
          resumed: true,
          abandoned: isAbandoned({ status: "DRAFT", updatedAt: existing.updatedAt }, now),
          ...context,
        },
      };
    }

    const created = await tx.visit.create({
      data: injected({
        id: uuidv7(),
        patientId: access.patientId,
        doctorId: access.callerDoctorId,
        appointmentId,
        status: "DRAFT",
        createdBy: caller.actor.userId,
      }),
      select: DRAFT_COLUMNS,
    });

    // The consultation reception already booked becomes this visit's first procedure line (Q25),
    // priced from what reception quoted rather than from what the service costs today.
    const booked = await tx.appointment.findFirst({
      where: { id: appointmentId },
      select: { serviceId: true, quotedPriceMinor: true },
    });
    if (booked !== null) {
      await seedReceptionLine(tx, caller.actor.userId, created.id, booked);
    }
    // A draft created this instant cannot be abandoned; stated rather than assumed.
    return { ok: true as const, value: { ...created, resumed: false, abandoned: false, ...context } };
  });
}

/**
 * Save into a draft, refusing when the caller's revision is not the one on the row.
 *
 * Compare-and-set in a single UPDATE ... WHERE revision = expected, so the check and the write
 * cannot be separated by another client's save. Never last-write-wins, never a lock (Q7).
 */
export async function saveDraft(
  caller: CallerContext,
  visitId: string,
  expectedRevision: number,
  patch: DraftPatch,
): Promise<DraftResult<VisitDraft>> {
  return withTenant(caller.tenantId, caller.actor, async (tx) => {
    // `vitals` is a Json column, which Prisma types separately from the text fields — an absent key
    // must stay absent rather than becoming a JSON null that overwrites what was measured.
    const { vitals, ...text } = patch;
    const updated = await tx.visit.updateMany({
      where: { id: visitId, status: "DRAFT", revision: expectedRevision, ...visitScope(caller) },
      data: {
        ...text,
        ...(vitals === undefined ? {} : { vitals: vitals ?? Prisma.JsonNull }),
        revision: { increment: 1 },
      },
    });

    if (updated.count === 0) {
      // Either the row is not the caller's to write, or someone saved first. Distinguished by a
      // scoped read: a draft the caller cannot see is NOT_FOUND, one they can is STALE_REVISION.
      const current = await tx.visit.findFirst({
        where: { id: visitId, status: "DRAFT", ...visitScope(caller) },
        select: DRAFT_COLUMNS,
      });
      if (current === null) {
        return {
          ok: false as const,
          refusal: { code: "NOT_FOUND" as const, params: { resource: "visit" } },
        };
      }
      return {
        ok: false as const,
        refusal: { code: "STALE_REVISION" as const, params: { revision: current.revision } },
      };
    }

    const saved = await tx.visit.findFirst({
      where: { id: visitId, ...visitScope(caller) },
      select: DRAFT_COLUMNS,
    });
    return { ok: true as const, value: { ...saved!, resumed: true, abandoned: false } };
  });
}
