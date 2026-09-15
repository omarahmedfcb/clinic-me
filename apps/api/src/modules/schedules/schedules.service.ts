import type { MembershipRole, ScheduleExceptionType } from "../../generated/prisma/client.ts";
import { permissionLevel } from "../../common/permissions.ts";
import type { RefusalParams } from "../../common/refusals.ts";
import { injected } from "../../prisma/injected.ts";
import { withTenant, type ActorContext, type TransactionClient } from "../../prisma/with-tenant.ts";
import { findEmptyWindow, findOverlap } from "./template-rules.ts";

/**
 * Doctor schedules: recurring templates, breaks inside them, and one-off exceptions.
 *
 * ## This module is where `own` stops being a word in a table
 *
 * `ARCHITECTURE.md` §8 gives a DOCTOR `own` on "Manage doctor schedules", and `permissions.ts`
 * says plainly why the guard cannot enforce that:
 *
 * > PermissionGuard only proves the role has *some* access to the capability — telling "own"
 * > apart from "full" against a *specific* resource needs the actual resource in hand, which a
 * > route-level guard checking a JWT claim never has.
 *
 * PHASE-1.md carried that forward as an open item: **"`own`-scoped routes ship with a test that
 * the query is scoped, not that the guard allowed the request."** This is the first module with a
 * real `own` resource, so this is where that lands.
 *
 * The enforcement is deliberately a **filter on the query**, not a check after the read. A doctor
 * asking about another doctor's schedule gets the same answer as one asking about a doctor who
 * does not exist — `null` — because to return 403 you would first have to read a row you are not
 * entitled to see, and the 403 itself confirms it exists. Same reasoning as the cross-tenant 404.
 */

export interface ScheduleCaller {
  tenantId: string;
  actor: ActorContext;
  /** From the validated JWT. Needed because `own` cannot be decided without it. */
  role: MembershipRole;
  membershipId: string;
}

export interface TemplateInput {
  weekday: number;
  startTime: string;
  endTime: string;
  validFrom: string;
  validTo: string | null;
  breaks: { startTime: string; endTime: string; label: string }[];
}

export interface ExceptionInput {
  /** `null` means every doctor in the tenant — a clinic-wide closure (Q13). */
  doctorId: string | null;
  date: string;
  type: ScheduleExceptionType;
  startTime: string | null;
  endTime: string | null;
  reason: string | null;
}

export interface DoctorSchedule {
  doctorId: string;
  templates: {
    id: string;
    weekday: number;
    startTime: string;
    endTime: string;
    validFrom: string;
    validTo: string | null;
    breaks: { id: string; startTime: string; endTime: string; label: string }[];
  }[];
  exceptions: {
    id: string;
    doctorId: string | null;
    date: string;
    type: ScheduleExceptionType;
    startTime: string | null;
    endTime: string | null;
    reason: string | null;
  }[];
}

export type ScheduleWriteResult =
  | { ok: true }
  | {
      ok: false;
      code: "NOT_FOUND" | "SCOPE_TOO_NARROW" | "OVERLAPPING_TEMPLATE" | "INVALID_WINDOW";
      params: RefusalParams;
    };

/** Prisma maps `@db.Time` through a Date whose date part is ignored. */
const time = (wall: string): Date => {
  const [h, m] = wall.split(":").map(Number) as [number, number];
  return new Date(Date.UTC(1970, 0, 1, h, m, 0));
};
const wall = (value: Date): string => value.toISOString().slice(11, 16);
const dateOnly = (value: string): Date => new Date(`${value}T00:00:00Z`);
const day = (value: Date): string => value.toISOString().slice(0, 10);

/**
 * The doctor this caller is allowed to touch, or `null` if they are not allowed to touch this one.
 *
 * A DOCTOR is resolved to their **own** doctor row through `membershipId`, which comes from the
 * validated JWT and never from the request. Anyone with `full` on the capability passes through.
 * Returning `null` rather than throwing keeps the "absence is a value" contract that lets the AI
 * tool layer call this without catching framework errors.
 */
async function resolveWritableDoctor(
  tx: TransactionClient,
  caller: ScheduleCaller,
  doctorId: string,
): Promise<{ id: string } | null> {
  const doctor = await tx.doctor.findFirst({ where: { id: doctorId }, select: { id: true, membershipId: true } });
  if (doctor === null) return null;

  if (permissionLevel(caller.role, "doctorSchedules.manage") === "own") {
    // The scope is applied to the comparison, not to a post-hoc authorisation decision: this
    // doctor row is the caller's own or it is not, and if it is not the answer is "no such thing".
    return doctor.membershipId === caller.membershipId ? { id: doctor.id } : null;
  }
  return { id: doctor.id };
}

export async function getDoctorSchedule(
  caller: ScheduleCaller,
  doctorId: string,
): Promise<DoctorSchedule | null> {
  return withTenant(caller.tenantId, caller.actor, async (tx) => {
    const doctor = await resolveWritableDoctor(tx, caller, doctorId);
    if (doctor === null) return null;

    const templates = await tx.scheduleTemplate.findMany({
      where: { doctorId },
      include: { breaks: true },
      orderBy: [{ weekday: "asc" }, { startTime: "asc" }],
    });

    const exceptions = await tx.scheduleException.findMany({
      where: { OR: [{ doctorId }, { doctorId: null }] },
      orderBy: { date: "asc" },
    });

    return {
      doctorId,
      templates: templates.map((t) => ({
        id: t.id,
        weekday: t.weekday,
        startTime: wall(t.startTime),
        endTime: wall(t.endTime),
        validFrom: day(t.validFrom),
        validTo: t.validTo === null ? null : day(t.validTo),
        breaks: t.breaks.map((b) => ({
          id: b.id,
          startTime: wall(b.startTime),
          endTime: wall(b.endTime),
          label: b.label,
        })),
      })),
      exceptions: exceptions.map((e) => ({
        id: e.id,
        doctorId: e.doctorId,
        date: day(e.date),
        type: e.type,
        startTime: e.startTime === null ? null : wall(e.startTime),
        endTime: e.endTime === null ? null : wall(e.endTime),
        reason: e.reason,
      })),
    };
  });
}

/**
 * Replace a doctor's recurring templates wholesale.
 *
 * A whole-set PUT rather than per-row edits, because the thing being validated — that no two
 * templates for one weekday overlap — is a property of the *set*. Patching one row at a time means
 * every intermediate state has to be legal too, which either forbids legitimate rearrangements or
 * lets an overlap exist between two requests.
 *
 * **Overlaps are rejected here and tolerated by the engine** (Q6), deliberately: rejection belongs
 * at the write, where a human is present to fix it, and a pure function that threw on stored data
 * would make a doctor's whole day un-bookable over one bad row entered last month.
 */
export async function replaceTemplates(
  caller: ScheduleCaller,
  doctorId: string,
  templates: TemplateInput[],
): Promise<ScheduleWriteResult> {
  const overlap = findOverlap(templates);
  if (overlap !== null) return { ok: false, code: "OVERLAPPING_TEMPLATE", params: overlap };

  const empty = findEmptyWindow(templates);
  if (empty !== null) return { ok: false, code: "INVALID_WINDOW", params: empty };

  return withTenant(caller.tenantId, caller.actor, async (tx) => {
    const doctor = await resolveWritableDoctor(tx, caller, doctorId);
    if (doctor === null) {
      return {
        ok: false as const,
        code: "NOT_FOUND" as const,
        params: { resource: "doctor" } as const,
      };
    }

    const existing = await tx.scheduleTemplate.findMany({ where: { doctorId }, select: { id: true } });
    await tx.scheduleBreak.deleteMany({
      where: { scheduleTemplateId: { in: existing.map((t) => t.id) } },
    });
    await tx.scheduleTemplate.deleteMany({ where: { doctorId } });

    for (const template of templates) {
      const created = await tx.scheduleTemplate.create({
        data: injected({
          doctorId,
          weekday: template.weekday,
          startTime: time(template.startTime),
          endTime: time(template.endTime),
          validFrom: dateOnly(template.validFrom),
          validTo: template.validTo === null ? null : dateOnly(template.validTo),
        }),
      });

      for (const brk of template.breaks) {
        await tx.scheduleBreak.create({
          data: injected({
            scheduleTemplateId: created.id,
            startTime: time(brk.startTime),
            endTime: time(brk.endTime),
            label: brk.label,
          }),
        });
      }
    }

    return { ok: true as const };
  });
}

export async function addException(
  caller: ScheduleCaller,
  input: ExceptionInput,
): Promise<ScheduleWriteResult> {
  return withTenant(caller.tenantId, caller.actor, async (tx) => {
    if (input.doctorId !== null) {
      const doctor = await resolveWritableDoctor(tx, caller, input.doctorId);
      if (doctor === null) {
        return {
        ok: false as const,
        code: "NOT_FOUND" as const,
        params: { resource: "doctor" } as const,
      };
      }
    } else if (permissionLevel(caller.role, "doctorSchedules.manage") === "own") {
      // A clinic-wide closure is not "own" anything. A doctor may close their own diary; closing
      // the clinic is an admin act.
      return {
        // SCOPE_TOO_NARROW, not NOT_FOUND: the exception is not missing, the caller's permission
        // is. It asks for a different action -- have an admin do it -- so by the ruling it earns
        // its own code, and a permission refusal stops being reported as an absence.
        ok: false as const,
        code: "SCOPE_TOO_NARROW" as const,
        params: {},
      };
    }

    await tx.scheduleException.create({
      data: injected({
        doctorId: input.doctorId,
        date: dateOnly(input.date),
        type: input.type,
        startTime: input.startTime === null ? null : time(input.startTime),
        endTime: input.endTime === null ? null : time(input.endTime),
        reason: input.reason,
      }),
    });

    return { ok: true as const };
  });
}

export async function removeException(
  caller: ScheduleCaller,
  exceptionId: string,
): Promise<ScheduleWriteResult> {
  return withTenant(caller.tenantId, caller.actor, async (tx) => {
    const existing = await tx.scheduleException.findFirst({ where: { id: exceptionId } });
    if (existing === null) {
      return {
        ok: false as const,
        code: "NOT_FOUND" as const,
        params: { resource: "exception" } as const,
      };
    }

    if (existing.doctorId !== null) {
      const doctor = await resolveWritableDoctor(tx, caller, existing.doctorId);
      if (doctor === null) {
        return {
        ok: false as const,
        code: "NOT_FOUND" as const,
        params: { resource: "exception" } as const,
      };
      }
    } else if (permissionLevel(caller.role, "doctorSchedules.manage") === "own") {
      return {
        ok: false as const,
        code: "NOT_FOUND" as const,
        params: { resource: "exception" } as const,
      };
    }

    await tx.scheduleException.delete({ where: { id: exceptionId } });
    return { ok: true as const };
  });
}
