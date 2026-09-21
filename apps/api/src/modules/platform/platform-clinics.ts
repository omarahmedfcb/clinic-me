// The platform console's clinic operations — pilot-readiness 0b–0e. Directory data and aggregates
// only; nothing here reads a clinical or financial row, and `platform-reads-no-clinic-data` proves it.

import { uuidv7 } from "uuidv7";
import type { RefusalParams } from "../../common/refusals.ts";
import { injected } from "../../prisma/injected.ts";
import { prisma } from "../../prisma/client.ts";
import { withPlatformActor, withTenant, type ActorContext } from "../../prisma/with-tenant.ts";
import { hashPassword } from "../auth/password.ts";
import { normalisePhone } from "../auth/phone.ts";
import { generateTemporaryPassword } from "../memberships/staff.service.ts";
import { accountStatesFor } from "./platform-client-file.ts";
import { newTenantData, type SupportedCountry } from "./new-clinic.ts";
import { planFor, type PlanLine } from "./plan.ts";

export type ClinicRefusal =
  | "NOT_FOUND"
  | "INVALID_PHONE"
  | "SLUG_TAKEN"
  | "DUPLICATE_PHONE"
  | "REASON_REQUIRED"
  | "ALREADY_IN_THAT_STATE";

export type ClinicResult<T> = { ok: true; value: T } | { ok: false; code: ClinicRefusal; params: RefusalParams };

export interface ClinicRow {
  tenantId: string;
  name: string;
  slug: string;
  country: string;
  currency: string;
  timezone: string;
  status: string;
  suspensionReason: string | null;
  createdAt: Date;
  /** The most recent appointment in the clinic. Null for one that has booked nothing yet. */
  lastActivity: Date | null;
  patients: number;
  doctors: number;
  staff: number;
  appointmentsThisMonth: number;
  /** Computed from PRICING.md every time it is asked. Never stored — see `plan.ts`. */
  plan: PlanLine;
  /** Who a temporary password may be issued to (0e). ADMIN and OWNER only, never a doctor. */
  admins: { userId: string; fullName: string; role: string }[];
  /** TRIAL | ACTIVE | OVERDUE | SUSPENDED, from the client file. TRIAL for a clinic with no file. */
  accountStatus: string;
  renewalOn: string | null;
  /** Whole days until the renewal, negative once it is past. Null when no date is recorded. */
  renewalInDays: number | null;
  /** Inside the 14-day window the founder asked the console to warn on, or already past it. */
  renewalDue: boolean;
}

interface AdminRow {
  tenant_id: string;
  user_id: string;
  full_name: string;
  role: string;
}

interface CountsRow {
  tenant_id: string;
  patients: number;
  doctors: number;
  staff: number;
  appointments_this_month: number;
  last_activity: Date | null;
}

/**
 * Every clinic, with aggregates and a computed plan line.
 *
 * The counts come from `platform_clinic_counts()`, a SECURITY DEFINER function whose return type is
 * integers and instants — so there is no field a later change could widen into a patient name
 * without altering a signature somebody has to review. The operator's own session stays unbound, and
 * `tenants` is the one table an unbound session may read (D22): clinic directory data, which every
 * clinic already prints on its own letterhead.
 */
export async function listClinics(actor: ActorContext, today: Date = new Date()): Promise<ClinicRow[]> {
  const accounts = await accountStatesFor(actor, today);

  return withPlatformActor(actor, async (tx) => {
    const [tenants, counts, admins] = await Promise.all([
      tx.tenant.findMany({ orderBy: { createdAt: "asc" } }),
      tx.$queryRaw<CountsRow[]>`SELECT * FROM platform_clinic_counts()`,
      tx.$queryRaw<AdminRow[]>`SELECT * FROM platform_clinic_admins()`,
    ]);

    const byTenant = new Map(counts.map((row) => [row.tenant_id, row]));

    return tenants.map((tenant) => {
      const count = byTenant.get(tenant.id);
      const doctors = count?.doctors ?? 0;
      // A clinic with no client file yet reads as a trial with no renewal date, which is what it is.
      const account = accounts.get(tenant.id) ?? {
        accountStatus: "TRIAL",
        renewalOn: null,
        renewalInDays: null,
        renewalDue: false,
      };
      return {
        ...account,
        tenantId: tenant.id,
        name: tenant.name,
        slug: tenant.slug,
        country: tenant.country,
        currency: tenant.currency,
        timezone: tenant.timezone,
        status: tenant.status,
        suspensionReason: tenant.suspensionReason,
        createdAt: tenant.createdAt,
        lastActivity: count?.last_activity ?? null,
        patients: count?.patients ?? 0,
        doctors,
        staff: count?.staff ?? 0,
        appointmentsThisMonth: count?.appointments_this_month ?? 0,
        plan: planFor(doctors),
        admins: admins
          .filter((row) => row.tenant_id === tenant.id)
          .map((row) => ({ userId: row.user_id, fullName: row.full_name, role: row.role })),
      };
    });
  });
}

export interface NewClinic {
  name: string;
  slug: string;
  timezone: string;
  country: SupportedCountry;
  currency: string;
  address: string;
  phone: string;
  adminFullName: string;
  adminPhone: string;
}

/**
 * Creates a clinic and seats its first ADMIN — 0b, and the reason the console exists at all: there
 * is no self-serve signup, and the first admin is created by us (PILOT-READINESS.md 5d).
 *
 * **Two sessions, deliberately.** The tenant row is written unbound, because there is no tenant to
 * bind before it exists — the case `tenants`' inverted RLS policy was written for (D22). The
 * membership is then written inside the tenant that was just created.
 *
 * The operator binds a clinic's tenant in exactly two places, both of which write and neither of
 * which reads clinical data: here, and `recordOperatorAction`, whose row belongs in that clinic's
 * own trail. `platform-tenant-bindings.spec.ts` fails the build when a third appears.
 */
export async function createClinic(
  actor: ActorContext,
  input: NewClinic,
): Promise<ClinicResult<{ tenantId: string; adminUserId: string; temporaryPassword: string }>> {
  // **The clinic's own country**, not `DEFAULT_PHONE_COUNTRY`: two clinics in one deployment can
  // be in two countries, which is what §18b means by the tenant's country being the hint.
  const adminPhone = normalisePhone(input.adminPhone, input.country);
  if (adminPhone === null) return { ok: false, code: "INVALID_PHONE", params: {} };

  const clinicPhone = normalisePhone(input.phone, input.country);
  if (clinicPhone === null) return { ok: false, code: "INVALID_PHONE", params: {} };

  const slugTaken = await prisma.tenant.findFirst({ where: { slug: input.slug }, select: { id: true } });
  if (slugTaken !== null) return { ok: false, code: "SLUG_TAKEN", params: { name: input.slug } };

  const phoneTaken = await prisma.user.findFirst({ where: { phoneE164: adminPhone }, select: { id: true } });
  if (phoneTaken !== null) return { ok: false, code: "DUPLICATE_PHONE", params: {} };

  const temporaryPassword = generateTemporaryPassword();
  const passwordHash = await hashPassword(temporaryPassword);

  // The same shape the seed writes (0g) — `new-clinic.ts` is the one definition of it.
  const tenantData = newTenantData({ ...input, phone: clinicPhone });
  const tenantId = tenantData.id;
  const adminUserId = uuidv7();

  await withPlatformActor(actor, async (tx) => {
    await tx.tenant.create({ data: tenantData });

    // `users` is a person, not a clinic's record of one, so it is written here rather than inside
    // the tenant. `must_change_password` is what makes the temporary password temporary.
    await tx.user.create({
      data: {
        id: adminUserId,
        fullName: input.adminFullName,
        phoneE164: adminPhone,
        passwordHash,
        mustChangePassword: true,
        status: "ACTIVE",
      },
    });
  });

  // The one tenant binding in this module, for the one write that needs it.
  await withTenant(tenantId, actor, async (tx) => {
    await tx.membership.create({
      data: injected({ id: uuidv7(), userId: adminUserId, role: "ADMIN", status: "ACTIVE" }),
    });
  });

  return { ok: true, value: { tenantId, adminUserId, temporaryPassword } };
}

/**
 * Suspends or reactivates — 0d. **Never deletes**: `ARCHITECTURE.md` §6 rules that a clinic which
 * stops paying must not lose patient records, which is a PDPL problem rather than a commercial one.
 *
 * The reason and the instant are written with the status, and a CHECK refuses the combination where
 * one is missing. Reactivating clears both, so a live clinic never carries a stale explanation.
 */
export async function setClinicSuspension(
  actor: ActorContext,
  tenantId: string,
  input: { suspended: boolean; reason?: string },
): Promise<ClinicResult<{ status: string }>> {
  if (input.suspended && (input.reason ?? "").trim() === "") {
    return { ok: false, code: "REASON_REQUIRED", params: {} };
  }

  return withPlatformActor<ClinicResult<{ status: string }>>(actor, async (tx) => {
    const tenant = await tx.tenant.findFirst({ where: { id: tenantId }, select: { status: true } });
    if (tenant === null) return { ok: false as const, code: "NOT_FOUND" as const, params: { resource: "clinic" as const } };

    const target = input.suspended ? "SUSPENDED" : "ACTIVE";
    if (tenant.status === target) {
      return { ok: false as const, code: "ALREADY_IN_THAT_STATE" as const, params: { status: target } };
    }

    await tx.tenant.update({
      where: { id: tenantId },
      data: input.suspended
        ? { status: "SUSPENDED", suspensionReason: (input.reason ?? "").trim(), suspendedAt: new Date() }
        : { status: "ACTIVE", suspensionReason: null, suspendedAt: null },
    });

    return { ok: true as const, value: { status: target } };
  });
}

/**
 * Resets a clinic admin's password on request — 0e. The operator never sees the old one, and the
 * new one is shown once: `must_change_password` forces its replacement at the next sign-in.
 *
 * Narrowed to an ADMIN or OWNER of the named clinic, so this cannot become a way to take over a
 * doctor's account — the one whose login reaches clinical content.
 */
export async function resetClinicAdminPassword(
  actor: ActorContext,
  tenantId: string,
  userId: string,
): Promise<ClinicResult<{ temporaryPassword: string; fullName: string }>> {
  const membership = await withTenant(tenantId, actor, (tx) =>
    tx.membership.findFirst({
      where: { userId, status: "ACTIVE", role: { in: ["ADMIN", "OWNER"] } },
      select: { id: true },
    }),
  ).catch(() => null);
  if (membership === null) {
    return { ok: false, code: "NOT_FOUND", params: { resource: "membership" } };
  }

  const temporaryPassword = generateTemporaryPassword();
  const passwordHash = await hashPassword(temporaryPassword);

  const user = await withPlatformActor(actor, (tx) =>
    tx.user.update({
      where: { id: userId },
      data: { passwordHash, mustChangePassword: true },
      select: { fullName: true },
    }),
  );

  return { ok: true, value: { temporaryPassword, fullName: user.fullName } };
}
