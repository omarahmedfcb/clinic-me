import { uuidv7 } from "uuidv7";
import { prisma } from "../../src/prisma/client.ts";
import { hashPassword } from "../../src/modules/auth/password.ts";
import { injected } from "../../src/prisma/injected.ts";
import { type ActorContext, withTenant } from "../../src/prisma/with-tenant.ts";
import { newTenantData } from "../../src/modules/platform/new-clinic.ts";
import { type ClinicBlueprint, SEED_PASSWORD, WORKING_WEEKDAYS } from "./blueprint.ts";
import { dateOnly, timeOnly } from "./zoned-time.ts";

/**
 * Staff-side seeding: the tenant, its people, and the fixed configuration a clinic needs before
 * anybody can book anything.
 *
 * Note where the boundary falls. `tenants` and `users` carry no `tenant_id`, no RLS policy and no
 * audit trigger -- they are cross-tenant by design (a user can belong to two clinics), so they are
 * written with the plain client. Everything from `memberships` downwards is tenant-scoped, and so
 * goes through withTenant() with the system actor, exactly as application code must. There is no
 * seed-only shortcut: the tenant-scoping extension throws without a bound tenant context, and the
 * audit trigger raises without a bound actor.
 */

export interface SeededStaff {
  tenantId: string;
  /** Blueprint key -> users.id, for wiring appointment/visit/payment actors. */
  userIdByKey: Map<string, string>;
  /** Blueprint key -> doctors.id. */
  doctorIdByKey: Map<string, string>;
  doctorKeys: string[];
  serviceIds: string[];
  /** Parallel to serviceIds. */
  serviceDurations: number[];
  servicePrices: number[];
  receptionUserId: string;
}

/**
 * Creates the `users` row for one staff member, or returns the existing one.
 *
 * The lookup is by phone because `phone_e164` is the UNIQUE column every real user is guaranteed
 * to have (email is nullable). It is also what makes the doctor who works at both clinics resolve
 * to a single user row with two memberships rather than two unrelated accounts -- the case
 * PHASE-1.md's tenant-switcher requirement depends on.
 */
async function upsertStaffUser(
  fullName: string,
  phoneE164: string,
  email: string | null,
  passwordHash: string,
): Promise<string> {
  const existing = await prisma.user.findUnique({ where: { phoneE164 }, select: { id: true } });
  if (existing) return existing.id;

  const created = await prisma.user.create({
    // `id` is supplied rather than left to the extension's uuidv7 injection: users are written
    // with the plain client, and Prisma's create input requires it. Same value either way (D6).
    data: { id: uuidv7(), phoneE164, email, fullName, passwordHash, status: "ACTIVE", isPlatformAdmin: false },
    select: { id: true },
  });
  return created.id;
}

/**
 * Seeds one clinic's tenant row, staff, services and weekly schedules.
 *
 * `validFrom` on the schedule templates is backdated ahead of the appointment window so that every
 * generated appointment falls inside a schedule that was already in force -- a template starting
 * today would leave three months of history sitting outside any working hours, which is exactly
 * the kind of quietly inconsistent data that makes a seeded database useless for judging whether
 * a screen is right.
 */
export async function seedStaff(
  clinic: ClinicBlueprint,
  actor: ActorContext,
  scheduleValidFrom: Date,
  /** SEED_REFERENCE_DATE. Passed in rather than derived from scheduleValidFrom's offset, which
   * would make the two silently drift if that margin ever changed. */
  referenceDate: Date,
): Promise<SeededStaff> {
  // 0g: the same definition the platform console writes, so a column added to a new clinic cannot
  // reach one path and miss the other. The seed still seats its own staff from the blueprint.
  const tenant = await prisma.tenant.create({
    data: newTenantData(clinic),
    select: { id: true },
  });
  const tenantId = tenant.id;

  // Argon2id is intentionally slow. Every seeded account shares one password, so the hash is
  // computed once and reused rather than once per user -- ten Argon2 hashes would add seconds to
  // every run for no benefit, since the plaintext is identical and public anyway.
  const passwordHash = await hashPassword(SEED_PASSWORD);

  const userIdByKey = new Map<string, string>();
  for (const member of clinic.staff) {
    const userId = await upsertStaffUser(member.fullName, member.phoneE164, member.email, passwordHash);
    userIdByKey.set(member.key, userId);
  }

  const doctorIdByKey = new Map<string, string>();
  const doctorKeys: string[] = [];
  const serviceIds: string[] = [];
  const serviceDurations: number[] = [];
  const servicePrices: number[] = [];

  await withTenant(tenantId, actor, async (tx) => {
    for (const member of clinic.staff) {
      const userId = userIdByKey.get(member.key);
      if (userId === undefined) throw new Error(`seedStaff: no user seeded for "${member.key}".`);

      const membershipId = uuidv7();
      await tx.membership.create({
        data: injected({ id: membershipId, userId, role: member.role, status: "ACTIVE" }),
      });

      if (member.doctor === undefined) continue;

      const doctorId = uuidv7();
      await tx.doctor.create({
        data: injected({
          id: doctorId,
          membershipId,
          specialty: member.doctor.specialty,
          licenseNumber: member.doctor.licenseNumber,
          title: member.doctor.title,
          printedNameEn: member.doctor.printedNameEn,
          mayAdjustPrices: member.doctor.mayAdjustPrices ?? false,
          collectsPayments: member.doctor.collectsPayments ?? false,
          isActive: true,
        }),
      });
      doctorIdByKey.set(member.key, doctorId);
      doctorKeys.push(member.key);

      for (const weekday of WORKING_WEEKDAYS) {
        const templateId = uuidv7();
        await tx.scheduleTemplate.create({
          data: injected({
            id: templateId,
            doctorId,
            weekday,
            startTime: timeOnly(member.doctor.shift.startHour, member.doctor.shift.startMinute),
            endTime: timeOnly(member.doctor.shift.endHour, member.doctor.shift.endMinute),
            validFrom: dateOnly(
              scheduleValidFrom.getUTCFullYear(),
              scheduleValidFrom.getUTCMonth() + 1,
              scheduleValidFrom.getUTCDate(),
            ),
            validTo: null,
          }),
        });

        await tx.scheduleBreak.create({
          data: injected({
            scheduleTemplateId: templateId,
            startTime: timeOnly(member.doctor.break.startHour, member.doctor.break.startMinute),
            endTime: timeOnly(member.doctor.break.endHour, member.doctor.break.endMinute),
            label: member.doctor.break.label,
          }),
        });
      }
    }

    for (const service of clinic.services) {
      const serviceId = uuidv7();
      await tx.service.create({
        data: injected({
          id: serviceId,
          nameAr: service.nameAr,
          nameEn: service.nameEn,
          type: service.type,
          durationMinutes: service.durationMinutes,
          priceMinor: service.priceMinor,
          isActive: true,
        }),
      });
      serviceIds.push(serviceId);
      serviceDurations.push(service.durationMinutes);
      servicePrices.push(service.priceMinor);
    }

    /**
     * One-off schedule changes. Dates are derived from `scheduleValidFrom`'s own reference rather
     * than from the clock, so a seeded database is the same on any day it is built -- the same
     * rule the rest of this file follows (SEED_REFERENCE_DATE, blueprint.ts).
     *
     * `doctorKey: null` writes a clinic-wide row (`doctor_id IS NULL`), which is what makes
     * HOLIDAY distinct from BLOCKED and is the only way to express "the clinic is closed" without
     * one row per doctor.
     */
    for (const exception of clinic.exceptions) {
      const doctorId = exception.doctorKey === null ? null : doctorIdByKey.get(exception.doctorKey);
      if (doctorId === undefined) {
        throw new Error(
          `seedStaff: clinic "${clinic.slug}" has an exception for unknown doctor key ` +
            `"${exception.doctorKey}". Blueprint keys and staff keys have drifted apart.`,
        );
      }

      const when = new Date(referenceDate.getTime() + exception.dayOffset * 86_400_000);
      await tx.scheduleException.create({
        data: injected({
          doctorId,
          date: dateOnly(when.getUTCFullYear(), when.getUTCMonth() + 1, when.getUTCDate()),
          type: exception.type,
          startTime:
            exception.startHour === null
              ? null
              : timeOnly(exception.startHour, exception.startMinute ?? 0),
          endTime:
            exception.endHour === null ? null : timeOnly(exception.endHour, exception.endMinute ?? 0),
          reason: exception.reason,
        }),
      });
    }
  });

  const receptionUserId = userIdByKey.get("reception") ?? userIdByKey.get("owner");
  if (receptionUserId === undefined) {
    throw new Error(`seedStaff: clinic "${clinic.slug}" has neither a reception nor an owner account.`);
  }

  return {
    tenantId,
    userIdByKey,
    doctorIdByKey,
    doctorKeys,
    serviceIds,
    serviceDurations,
    servicePrices,
    receptionUserId,
  };
}
