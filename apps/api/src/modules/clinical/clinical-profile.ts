// The patient-level clinical profile, append-only with an author and a timestamp per entry. Q22.
// Allergies are NOT here — `patient_allergies` is the one list, and two would drift.

import { uuidv7 } from "uuidv7";
import type { ClinicalProfileField } from "../../generated/prisma/client.ts";
import type { RefusalParams } from "../../common/refusals.ts";
import { injected } from "../../prisma/injected.ts";
import { withTenant } from "../../prisma/with-tenant.ts";
import type { CallerContext } from "../appointments/appointments.service.ts";
import { isPresentWithDoctor, resolveAccess, type ClinicalRefusal } from "./clinical.access.ts";
import { visitScope } from "./visit-scope.ts";

export type ProfileRefusal = ClinicalRefusal | { code: "NOT_A_DOCTOR"; params: RefusalParams };

export type ProfileResult<T> = { ok: true; value: T } | { ok: false; refusal: ProfileRefusal };

export interface ProfileEntry {
  id: string;
  field: ClinicalProfileField;
  content: string;
  authorUserId: string;
  authorName: string;
  createdAt: Date;
}

export interface ClinicalProfileView {
  patientId: string;
  /** Newest first. Never edited and never removed, so the list only ever grows. */
  entries: ProfileEntry[];
  lastUpdatedAt: Date | null;
  lastUpdatedBy: string | null;
  /**
   * The most recently measured height, read from vitals rather than stored again here. Q22 lists
   * height among the standing facts; a second copy of a number that is already measured every
   * visit is the kind of duplicate that goes stale — the reason allergies are not duplicated either.
   */
  heightCm: number | null;
  /** True when this patient has no completed visit yet, so the screen knows to show it expanded. */
  firstVisit: boolean;
}

/**
 * Read the profile for the patient on this appointment.
 *
 * Appointment-scoped like every other clinical read, so ownership comes from `resolveAccess` and
 * the transfer grant composes without being mentioned — the reversal Q18 already paid for. A
 * patient with no entries returns an empty list rather than 404: nothing recorded is a legitimate
 * answer, and a 404 would make the screen show an error for an ordinary state.
 */
export async function getClinicalProfile(
  caller: CallerContext,
  appointmentId: string,
  now: Date,
): Promise<ProfileResult<ClinicalProfileView>> {
  return withTenant(caller.tenantId, caller.actor, async (tx) => {
    const resolved = await resolveAccess(tx, caller, appointmentId, now);
    if (!resolved.ok) return { ok: false as const, refusal: resolved.refusal };
    const { access } = resolved;
    if (
      !access.mayReadFullHistory &&
      !(
        access.callerDoctorId !== null &&
        (await isPresentWithDoctor(tx, access.patientId, access.callerDoctorId))
      )
    ) {
      return { ok: false as const, refusal: { code: "NOT_PRESENT" as const, params: {} } };
    }

    const [rows, visits] = await Promise.all([
      tx.patientClinicalProfileEntry.findMany({
        where: { patientId: access.patientId },
        select: {
          id: true,
          field: true,
          content: true,
          authorUserId: true,
          createdAt: true,
          authorUser: { select: { fullName: true } },
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      }),
      tx.visit.findMany({
        where: { patientId: access.patientId, status: "COMPLETED", ...visitScope(caller) },
        select: { vitals: true, completedAt: true },
        orderBy: [{ completedAt: "desc" }, { createdAt: "desc" }],
      }),
    ]);

    const entries: ProfileEntry[] = rows.map(({ authorUser, ...entry }) => ({
      ...entry,
      authorName: authorUser.fullName,
    }));

    return {
      ok: true as const,
      value: {
        patientId: access.patientId,
        entries,
        lastUpdatedAt: entries[0]?.createdAt ?? null,
        lastUpdatedBy: entries[0]?.authorName ?? null,
        heightCm: latestHeight(visits.map((visit) => visit.vitals)),
        firstVisit: visits.length === 0,
      },
    };
  });
}

/** The most recent visit that actually recorded a height. An absent measurement is skipped, not zero. */
function latestHeight(vitals: unknown[]): number | null {
  for (const measured of vitals) {
    const height = (measured as { heightCm?: unknown } | null)?.heightCm;
    if (typeof height === "number" && Number.isFinite(height)) return height;
  }
  return null;
}

export interface NewProfileEntry {
  field: ClinicalProfileField;
  content: string;
}

/**
 * Add one entry. There is no update and no delete, at this layer or below it (Q22).
 *
 * Any doctor with access may add — the profile is the patient's, not its first author's. Who said
 * what is answered by the entry's own author and timestamp rather than by ownership of the row.
 */
export async function addClinicalProfileEntry(
  caller: CallerContext,
  appointmentId: string,
  entry: NewProfileEntry,
  now: Date,
): Promise<ProfileResult<ClinicalProfileView>> {
  const written = await withTenant(caller.tenantId, caller.actor, async (tx) => {
    const resolved = await resolveAccess(tx, caller, appointmentId, now);
    if (!resolved.ok) return { ok: false as const, refusal: resolved.refusal };
    const { access } = resolved;
    if (access.callerDoctorId === null) {
      return { ok: false as const, refusal: { code: "NOT_A_DOCTOR" as const, params: {} } };
    }
    // The write flag, not the read one: R-B lets a doctor read a past patient's record and does not
    // let them add to it. Presence is still asked patient-first, for the stale-appointment case.
    if (
      !access.mayWriteClinical &&
      !(await isPresentWithDoctor(tx, access.patientId, access.callerDoctorId))
    ) {
      return { ok: false as const, refusal: { code: "NOT_PRESENT" as const, params: {} } };
    }

    await tx.patientClinicalProfileEntry.create({
      data: injected({
        id: uuidv7(),
        patientId: access.patientId,
        field: entry.field,
        content: entry.content,
        authorUserId: caller.actor.userId,
      }),
    });
    return { ok: true as const };
  });

  if (!written.ok) return { ok: false, refusal: written.refusal };
  return getClinicalProfile(caller, appointmentId, now);
}
