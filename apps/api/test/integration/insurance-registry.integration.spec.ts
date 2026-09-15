import { randomUUID } from "node:crypto";
import { prisma } from "../../src/prisma/client.ts";
import { injected } from "../../src/prisma/injected.ts";
import { withTenant } from "../../src/prisma/with-tenant.ts";
import {
  createInsuranceCompany,
  listInsuranceCompanies,
  selectableInsuranceCompanies,
  updateInsuranceCompany,
} from "../../src/modules/insurance/insurance-companies.service.ts";
import { recordCoverage } from "../../src/modules/insurance/insurance.service.ts";
import { actorFor, seedClinic, teardownClinic, type ClinicFixture } from "./fixtures.ts";

/**
 * The insurance company registry — `PHASE-5-PLAN.md` PR 1.
 *
 * **The guard the plan names is the cross-tenant one, and it needs two clinics to mean anything.**
 * `insurance_policies.company_id` is an ordinary foreign key, and a foreign key is *not*
 * tenant-scoped: the database will happily accept another clinic's company id. The only thing
 * stopping it is the lookup in `recordCoverage`, read through the tenant extension — so a test with
 * one clinic in it would pass with that lookup deleted.
 */

describe("the insurance company registry", () => {
  let clinic: ClinicFixture;
  let other: ClinicFixture;
  const caller = () => ({ tenantId: clinic.tenantId, actor: actorFor(clinic.userId) });

  beforeAll(async () => {
    clinic = await seedClinic();
    other = await seedClinic();

    // The fixture patient has no contact row, and a policy hangs off the household rather than the
    // patient -- so without this every recordCoverage below refuses with NO_CONTACT_RECORD, which
    // would have made the cross-tenant assertions pass for the wrong reason.
    await withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) => {
      const contact = await tx.contact.create({
        data: injected({ id: randomUUID(), phoneE164: "+201000000111" }),
        select: { id: true },
      });
      await tx.patient.update({ where: { id: clinic.patientId }, data: { contactId: contact.id } });
    });
  });

  afterAll(async () => {
    await teardownClinic(other);
    await teardownClinic(clinic);
    await prisma.$disconnect();
  });

  test("a company is created and read back", async () => {
    const created = await createInsuranceCompany(caller(), {
      name: "MedNet",
      type: "TPA",
      contractNumber: "C-1",
      contractStart: "2026-01-01",
      contractEnd: "2026-12-31",
      paymentTermsDays: 30,
      priorApprovalRequired: true,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    expect(created.value).toMatchObject({
      name: "MedNet",
      type: "TPA",
      contractStart: "2026-01-01",
      contractEnd: "2026-12-31",
      paymentTermsDays: 30,
      priorApprovalRequired: true,
      isActive: true,
    });
  });

  test("the same name in different letters is refused, because it is the same company", async () => {
    // Two receptionists typing "MedNet" and "MEDNET" would otherwise split one clinic's policies
    // across two registry rows, and neither list would be complete.
    const clash = await createInsuranceCompany(caller(), { name: "MEDNET", type: "INSURER" });
    expect(clash).toEqual({ ok: false, code: "DUPLICATE_COMPANY", params: { name: "MEDNET" } });
  });

  test("the same name in another clinic is fine, because a registry is per clinic", async () => {
    const elsewhere = await createInsuranceCompany(
      { tenantId: other.tenantId, actor: actorFor(other.userId) },
      { name: "MedNet", type: "TPA" },
    );
    expect(elsewhere.ok).toBe(true);
  });

  test("a contract that ends before it starts is refused", async () => {
    const backwards = await createInsuranceCompany(caller(), {
      name: "Backwards Insurance",
      type: "INSURER",
      contractStart: "2026-12-31",
      contractEnd: "2026-01-01",
    });
    expect(backwards).toEqual({ ok: false, code: "INVALID_WINDOW", params: {} });
  });

  test("a deactivated company stays in the admin list and leaves the selectable one", async () => {
    const created = await createInsuranceCompany(caller(), { name: "Retired Scheme", type: "CORPORATE" });
    if (!created.ok) throw new Error("setup failed");

    const off = await updateInsuranceCompany(caller(), created.value.id, { isActive: false });
    expect(off.ok).toBe(true);

    // Admin must still see it — a company that vanishes when deactivated cannot be reactivated.
    const admin = await listInsuranceCompanies(caller(), true);
    expect(admin.map((c) => c.name)).toContain("Retired Scheme");

    // Reception must not be offered it.
    const selectable = await selectableInsuranceCompanies(caller());
    expect(selectable.map((c) => c.name)).not.toContain("Retired Scheme");
  });

  test("updating a company in another clinic is a 404, not a 403", async () => {
    const theirs = await createInsuranceCompany(
      { tenantId: other.tenantId, actor: actorFor(other.userId) },
      { name: "Their Insurer", type: "INSURER" },
    );
    if (!theirs.ok) throw new Error("setup failed");

    const attempt = await updateInsuranceCompany(caller(), theirs.value.id, { name: "Renamed" });
    // 404 and never 403: a 403 would confirm the row exists (CLAUDE.md).
    expect(attempt).toEqual({
      ok: false,
      code: "NOT_FOUND",
      params: { resource: "insuranceCompany" },
    });
  });

  test("a policy may name a company from this clinic", async () => {
    const company = await createInsuranceCompany(caller(), { name: "Allianz Egypt", type: "INSURER" });
    if (!company.ok) throw new Error("setup failed");

    const recorded = await recordCoverage(caller(), clinic.patientId, {
      insurerName: "Allianz Egypt",
      companyId: company.value.id,
      planName: "Gold",
      isPrimary: true,
      policyNumber: "P-100",
      policyholderName: "Test Holder",
      validFrom: "2026-01-01",
      validTo: null,
      relationshipToPolicyholder: "SELF",
    });
    expect(recorded.ok).toBe(true);

    await withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) => {
      const policy = await tx.insurancePolicy.findFirstOrThrow({
        where: { policyNumber: "P-100" },
        select: { companyId: true, planName: true },
      });
      expect(policy).toEqual({ companyId: company.value.id, planName: "Gold" });
    });
  });

  test("a policy may NOT name another clinic's company", async () => {
    // **The guard.** The foreign key accepts any companies row; only the tenant-scoped lookup in
    // `recordCoverage` refuses this. Deleting that lookup makes this test fail and nothing else.
    const theirs = await createInsuranceCompany(
      { tenantId: other.tenantId, actor: actorFor(other.userId) },
      { name: "Foreign Insurer", type: "INSURER" },
    );
    if (!theirs.ok) throw new Error("setup failed");

    const attempt = await recordCoverage(caller(), clinic.patientId, {
      insurerName: "Foreign Insurer",
      companyId: theirs.value.id,
      policyNumber: "P-200",
      policyholderName: "Test Holder",
      validFrom: "2026-01-01",
      validTo: null,
      relationshipToPolicyholder: "SELF",
    });
    expect(attempt).toEqual({
      ok: false,
      code: "NOT_FOUND",
      params: { resource: "insuranceCompany" },
    });

    // And nothing was written on the way to refusing.
    await withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) => {
      expect(await tx.insurancePolicy.count({ where: { policyNumber: "P-200" } })).toBe(0);
    });
  });

  test("a patient holds at most one primary policy, enforced by the database", async () => {
    const company = await createInsuranceCompany(caller(), { name: "Second Insurer", type: "INSURER" });
    if (!company.ok) throw new Error("setup failed");

    // The first primary was recorded above. A second is refused by the partial unique index, not by
    // a service check — which is what makes it true for a bulk operation as well.
    await expect(
      withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) => {
        const policy = await tx.insurancePolicy.create({
          data: injected({
            id: randomUUID(),
            contactId: (
              await tx.patient.findFirstOrThrow({
                where: { id: clinic.patientId },
                select: { contactId: true },
              })
            ).contactId as string,
            insurerName: "Second Insurer",
            companyId: company.value.id,
            policyNumber: "P-300",
            policyholderName: "Test Holder",
            validFrom: new Date("2026-01-01T00:00:00Z"),
          }),
          select: { id: true },
        });
        await tx.patientInsurance.create({
          data: injected({
            id: randomUUID(),
            patientId: clinic.patientId,
            policyId: policy.id,
            relationshipToPolicyholder: "SELF",
            isPrimary: true,
          }),
        });
      }),
    ).rejects.toThrow();
  });
});
