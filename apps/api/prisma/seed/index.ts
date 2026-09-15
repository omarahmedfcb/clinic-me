import { prisma } from "../../src/prisma/client.ts";
import { type ActorContext, withTenant } from "../../src/prisma/with-tenant.ts";
import { systemActor } from "../../src/modules/audit/system-actor.ts";
import { listActiveMemberships } from "../../src/modules/auth/user-lookup.ts";
import {
  CLINICS,
  PLATFORM_ADMIN,
  resolveReferenceDate,
  SEED_PASSWORD,
  SHARED_STAFF_PHONE,
} from "./blueprint.ts";
import { ensurePlatformAdmin } from "./platform-admin.ts";

import { seedClinical } from "./seed-clinical.ts";
import { seedStaff } from "./seed-staff.ts";
import { RESEED_INSTRUCTIONS } from "./reseed-instructions.ts";

/**
 * Development seed. `npm run seed`.
 *
 * ── On re-running ────────────────────────────────────────────────────────────────────────────
 * This script is safely re-runnable, but it is not re-seedable, and the difference is worth
 * understanding because it follows from the system's own guarantees rather than from laziness.
 *
 * A seeded tenant cannot be deleted. Three independent things block it, verified by trying:
 *
 *   1. `appointment_events` is append-only (D5) -- its BEFORE UPDATE OR DELETE trigger raises for
 *      every role, so the seeded appointment history cannot be removed. In practice this is the
 *      first wall you hit.
 *   2. `audit_logs` is append-only too, and every insert this script makes fires the audit
 *      trigger, so a seeded tenant owns audit rows from its first membership onwards.
 *   3. `audit_logs.tenant_id` references `tenants` with ON DELETE RESTRICT (D18), so even an
 *      otherwise-empty tenant is pinned by the audit rows describing it.
 *
 * That is the medical-records guarantee working exactly as designed, on data that happens to be
 * fake. It is not a limitation of this script and there is no flag that would get past it.
 *
 * So "idempotent" here means: if the seed has already run, do nothing and say so. It does not mean
 * "wipe and start over", because wiping is structurally impossible. To genuinely re-seed, discard
 * the database — the recipe is `RESEED_INSTRUCTIONS` in `./reseed-instructions.ts`, and it is
 * deliberately **not** repeated here. It was, until 2026-09-07, and the copy in this comment and
 * the copy in the printed string were both missing the same step, which is what two copies are
 * for. `seed-reseed-instructions.spec.ts` now fails the build if a second copy reappears.
 *
 * ── Why it goes through withTenant() ─────────────────────────────────────────────────────────
 * Because there is no other way in, and that is the point. The tenant-scoping extension throws
 * without a bound tenant context, and the audit trigger raises without a bound actor, so a seed
 * that "just inserted rows" would have to bypass the application's own rules to work -- and would
 * then be proving nothing about them. Unattended writes use the seeded system actor, the same
 * identity ARCHITECTURE.md §9's nightly job uses.
 */

function summarise(label: string, value: string | number): string {
  return `  ${label.padEnd(22, " ")} ${String(value)}`;
}

async function main(): Promise<void> {
  const startedAt = Date.now();

  const existing = await prisma.tenant.findMany({
    where: { slug: { in: CLINICS.map((clinic) => clinic.slug) } },
    select: { slug: true, name: true },
  });

  if (existing.length > 0) {
    console.log("Seed data is already present. Nothing to do.\n");
    for (const tenant of existing) {
      console.log(summarise(tenant.slug, tenant.name));
    }
    console.log(
      "\nThis seed is re-runnable but not re-seedable: seeded tenants own append-only audit_logs\n" +
        "rows referencing them with ON DELETE RESTRICT, so they cannot be deleted. To start over,\n" +
        "discard the database volume:\n\n" +
        `${RESEED_INSTRUCTIONS}\n`,
    );
    return;
  }

  const actor = await systemActor();

  // Not `new Date()`. The generated world is built around a pinned instant so that two runs on
  // different days produce the same data -- see SEED_REFERENCE_DATE in blueprint.ts. `Date.now()`
  // still appears below, but only to time the run for the console; it never reaches the data.
  const referenceDate = resolveReferenceDate();

  console.log(`Seeding ${CLINICS.length} clinics as the system actor (${actor.userId}).\n`);

  // The operator, before any clinic: they belong to none, and 0a's whole point is that the console
  // is reachable without a membership anywhere.
  const operator = await ensurePlatformAdmin({ ...PLATFORM_ADMIN, password: SEED_PASSWORD });
  console.log(
    `Platform operator ${PLATFORM_ADMIN.phoneE164} ${operator.created ? "created" : "already present"} ` +
      "-- no membership in any clinic.",
  );

  console.log(`Reference date: ${referenceDate.toISOString()}`);

  let phoneBase = 60_000_000;
  for (const clinic of CLINICS) {
    const clinicStartedAt = Date.now();

    // Schedule templates must already be valid when the oldest generated appointment happens,
    // hence backdating a clear margin before the 90-day history window.
    const scheduleValidFrom = new Date(referenceDate.getTime() - 200 * 86_400_000);
    const staff = await seedStaff(clinic, actor, scheduleValidFrom, referenceDate);
    const totals = await seedClinical(clinic, staff, actor, referenceDate, phoneBase);
    await recordOneUserEdit(staff.tenantId, staff.receptionUserId, actor);
    phoneBase += 1_000_000;

    const seconds = ((Date.now() - clinicStartedAt) / 1000).toFixed(1);
    console.log(`${clinic.name}  (${clinic.slug})`);
    console.log(summarise("tenant id", staff.tenantId));
    // "memberships", not "accounts": the shared doctor holds one in each clinic, so the totals
    // across clinics count her twice while there is one of her.
    console.log(summarise("staff memberships", clinic.staff.length));
    console.log(summarise("doctors", staff.doctorKeys.length));
    console.log(summarise("services", staff.serviceIds.length));
    console.log(summarise("patients", totals.patients));
    console.log(summarise("appointments", totals.appointments));
    console.log(summarise("visits", totals.visits));
    console.log(summarise("payments", totals.payments));
    console.log(summarise("took", `${seconds}s`));
    console.log("");
  }

  console.log("Sign in with any seeded account:");
  console.log(summarise("password", SEED_PASSWORD));

  await describeSwitcherAccount(
    SHARED_STAFF_PHONE,
    "one person, two clinics -- the switcher moves between tenants",
  );
  console.log(`\nDone in ${((Date.now() - startedAt) / 1000).toFixed(1)}s.`);
}

/**
 * One audited edit to a `users` row, so `«سجل التدقيق»` is never empty of the record type it was
 * asked to show — ruled 2026-09-14.
 *
 * `users_audit` is `AFTER UPDATE ON users` **only**, and the seed created users and never updated
 * one. The result was 9,794 audit rows across 17 record types and not a single `users` row, so the
 * viewer's own filter did not offer `users` at all: a correct feature, indistinguishable on the
 * review stack from a broken one.
 *
 * The edit is the desk's email address, chosen because nothing signs in with it — the login is the
 * phone number — so the seeded world is unchanged in every way a reviewer interacts with. It runs
 * inside `withTenant` because the audit trigger refuses a write with no actor bound (D16).
 */
const EDITED_EMAIL_PREFIX = "desk.";

async function recordOneUserEdit(
  tenantId: string,
  userId: string,
  actor: ActorContext,
): Promise<void> {
  await withTenant(tenantId, actor, async (tx) => {
    const user = await tx.user.findFirstOrThrow({ where: { id: userId }, select: { email: true } });
    // Idempotent: re-running the seed must not stack prefixes, and must still leave the row audited.
    if (user.email !== null && !user.email.startsWith(EDITED_EMAIL_PREFIX)) {
      await tx.user.update({
        where: { id: userId },
        data: { email: `${EDITED_EMAIL_PREFIX}${user.email}` },
      });
    }

    // **The seed asserts its own outcome.** A seed that reports success and seeded nothing is this
    // project's most-repeated defect; the point of this function is a row, so the row is checked.
    const audited = await tx.auditLog.count({ where: { entityType: "users", action: "UPDATE" } });
    if (audited === 0) {
      throw new Error(
        "Seed: no `users` audit row was written, so «سجل التدقيق» would open without the record " +
          "type it exists to show. Check that users_audit is still AFTER UPDATE ON users.",
      );
    }
  });
}

/**
 * Prints the memberships behind one seeded phone number, with the role on every line.
 *
 * The role is not decoration: it is what the switcher shows beside each clinic. One person holds
 * one role per clinic (CLAUDE.md, 2026-09-09), so the seeded case is the shared doctor, who holds
 * one membership in each of two clinics.
 *
 * Read through list_active_memberships_for_user(), not a nested `memberships` include.
 * `memberships` is RLS-protected (D15) and this runs outside any tenant context, so a nested
 * include would silently return zero rows -- RLS failing closed, exactly as intended. The
 * SECURITY DEFINER function is the sanctioned way to ask "which tenants does this user belong
 * to?", a question that by definition precedes knowing the tenant.
 */
async function describeSwitcherAccount(phoneE164: string, why: string): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { phoneE164 },
    select: { id: true, fullName: true },
  });
  if (user === null) return;

  const memberships = await listActiveMemberships(user.id);
  console.log(`\n${user.fullName} (${phoneE164}) -- ${why}:`);
  for (const membership of memberships) {
    console.log(summarise("", `${membership.tenantName}  --  ${membership.role}`));
  }
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (error: unknown) => {
    console.error("\nSeed failed.\n");
    console.error(error);
    await prisma.$disconnect();
    process.exitCode = 1;
  });
