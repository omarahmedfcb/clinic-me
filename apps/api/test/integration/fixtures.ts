import { randomUUID } from "node:crypto";
import { prisma } from "../../src/prisma/client.ts";
import { injected } from "../../src/prisma/injected.ts";
import { type ActorContext, withTenant } from "../../src/prisma/with-tenant.ts";

/** withTenant() now requires an actor (D16); this is the one place tests build that value, always
 * from a real, already-created user id -- the row exists once the audit trigger's FK constraint
 * on audit_logs.actor_user_id starts enforcing that, which withTenant()'s own UUID-shape check
 * does not (deliberately -- it has no way to know a "real" id from a well-formed-but-fake one). */
export function actorFor(userId: string): ActorContext {
  return { userId, ip: "127.0.0.1", userAgent: "jest-integration-tests" };
}

/**
 * Fixture helpers shared across integration specs. Every scoped-model create below goes through
 * withTenant() -- the tenant-scoping extension throws if tenantContext isn't bound, regardless of
 * whether the specific table also carries Postgres RLS, so there is no lighter-weight path for
 * fixture setup than the one real code uses.
 */

export interface ClinicFixture {
  tenantId: string;
  userId: string;
  /**
   * The `DOCTOR` membership behind `doctorId`. Exposed because `own` scoping is decided on the
   * membership, not the user: `doctors.membership_id` is the only login-to-doctor link, and the
   * same human can hold memberships in two clinics.
   */
  membershipId: string;
  doctorId: string;
  serviceId: string;
  patientId: string;
}

function shortDigits(id: string): string {
  return id.replace(/-/g, "").slice(0, 8);
}

export async function createTestTenant(): Promise<string> {
  const id = randomUUID();
  await prisma.tenant.create({
    data: {
      id,
      name: `Test Tenant ${shortDigits(id)}`,
      slug: `test-tenant-${id}`,
      phone: "+201000000000",
      address: "Cairo",
      locale: "ar",
      currency: "EGP",
      status: "ACTIVE",
      settings: {},
    },
  });
  return id;
}

export async function deleteTestTenant(tenantId: string): Promise<void> {
  await prisma.tenant.delete({ where: { id: tenantId } }).catch(() => undefined);
}

export async function createTestUser(): Promise<string> {
  const id = randomUUID();
  await prisma.user.create({
    data: {
      id,
      phoneE164: `+2010${shortDigits(id)}`,
      passwordHash: "test-hash-not-real",
      fullName: "Test User",
      status: "ACTIVE",
    },
  });
  return id;
}

export async function deleteTestUser(userId: string): Promise<void> {
  await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
}

/** Seeds one tenant with a doctor (and the user/membership behind it), a service, and a patient. */
export async function seedClinic(): Promise<ClinicFixture> {
  const tenantId = await createTestTenant();
  const userId = await createTestUser();

  const { membershipId, doctorId, serviceId, patientId } = await withTenant(tenantId, actorFor(userId), async (tx) => {
    const membershipId = randomUUID();
    await tx.membership.create({
      data: injected({ id: membershipId, userId, role: "DOCTOR", status: "ACTIVE" }),
    });

    const doctorId = randomUUID();
    await tx.doctor.create({
      data: injected({
        id: doctorId,
        membershipId,
        specialty: "General",
        licenseNumber: `LIC-${shortDigits(doctorId)}`,
        title: "Dr.",
      }),
    });

    const serviceId = randomUUID();
    await tx.service.create({
      data: injected({
        id: serviceId,
        nameAr: "كشف",
        nameEn: "Consult",
        type: "NEW",
        durationMinutes: 30,
        priceMinor: 10000,
      }),
    });

    const patientId = randomUUID();
    await tx.patient.create({
      data: injected({
        id: patientId,
        fullNameAr: "Test Patient",
        phoneE164: `+2011${shortDigits(patientId)}`,
        relationshipToContact: "SELF",
        status: "ACTIVE",
      }),
    });

    return { membershipId, doctorId, serviceId, patientId };
  });

  return { tenantId, userId, membershipId, doctorId, serviceId, patientId };
}

export async function teardownClinic(fixture: ClinicFixture): Promise<void> {
  // payment_adjustments, visit_revisions, appointment_events, and audit_logs are append-only
  // (D5) -- BEFORE UPDATE OR DELETE triggers reject the delete unconditionally, for every role,
  // including this one. A test that creates any of those rows (sql-guarantees.integration.spec.ts
  // does, deliberately) makes deletion impossible not just for that row but, via ON DELETE
  // RESTRICT, for everything it references transitively -- its parent payment/visit/appointment,
  // and in turn patient/doctor/service/membership/tenant/user. That is the append-only guarantee
  // working correctly, not a cleanup bug. Cleanup here is therefore best-effort: this data is
  // inert, harmless, and confined to the disposable clinic_os_test database. A single failure
  // must not abort the whole attempt -- once one statement fails inside a transaction, Postgres
  // refuses every subsequent statement in it -- so this swallows failure at the transaction level
  // rather than trying to catch and continue past individual statements within one transaction.
  try {
    await withTenant(fixture.tenantId, actorFor(fixture.userId), async (tx) => {
      await tx.payment.deleteMany();
      await tx.visitProcedure.deleteMany();
      await tx.visit.deleteMany();
      await tx.appointment.deleteMany();
      await tx.patient.deleteMany();
      await tx.service.deleteMany();
      await tx.doctor.deleteMany();
      await tx.membership.deleteMany();
    });
  } catch {
    // best-effort; see comment above
  }
  await deleteTestUser(fixture.userId);
  await deleteTestTenant(fixture.tenantId);
}
