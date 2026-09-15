import { randomUUID } from "node:crypto";
import { prisma } from "../../src/prisma/client.ts";
import { injected } from "../../src/prisma/injected.ts";
import { withTenant } from "../../src/prisma/with-tenant.ts";
import { getPayerSplit, setPayerShare } from "../../src/modules/billing/payer-split.ts";
import { actorFor, seedClinic, teardownClinic, type ClinicFixture } from "./fixtures.ts";

/**
 * The payer split — Phase 5 PR 7, `PHASE-5-DESIGN.md` §4.2.
 *
 * **Manual, and the blocker is factual rather than preferential.** No coverage rate exists anywhere
 * in this schema — PR 1 shipped the registry with its two money fields deliberately absent — and
 * real Egyptian policies vary the rate by service, add annual ceilings and add per-visit
 * co-payments. So the guard here is not "the split is computed correctly"; it is that **the two
 * halves always sum to the charge**, enforced at the database, so a screen never has to render a
 * negative amount due and decide what it means.
 */

async function charge(clinic: ClinicFixture, subtotal: number, discount = 0) {
  return withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) => {
    const appointment = await tx.appointment.create({
      data: injected({
        id: randomUUID(),
        patientId: clinic.patientId,
        doctorId: clinic.doctorId,
        serviceId: clinic.serviceId,
        scheduledStart: new Date("2027-06-07T09:00:00Z"),
        scheduledEnd: new Date("2027-06-07T09:30:00Z"),
        status: "COMPLETED",
        source: "RECEPTION",
        createdBy: clinic.userId,
        updatedBy: clinic.userId,
        allowOverlap: true,
      }),
      select: { id: true },
    });
    const visit = await tx.visit.create({
      data: injected({
        id: randomUUID(),
        patientId: clinic.patientId,
        doctorId: clinic.doctorId,
        appointmentId: appointment.id,
        status: "COMPLETED",
        createdBy: clinic.userId,
      }),
      select: { id: true },
    });
    return tx.visitCharge.create({
      data: injected({
        id: randomUUID(),
        visitId: visit.id,
        patientId: clinic.patientId,
        subtotalMinor: subtotal,
        discountMinor: discount,
        discountReason: discount === 0 ? null : "goodwill",
      }),
      select: { id: true },
    });
  });
}

describe("the payer split", () => {
  let clinic: ClinicFixture;
  let other: ClinicFixture;
  const caller = () => ({
    tenantId: clinic.tenantId,
    actor: actorFor(clinic.userId),
    role: "RECEPTIONIST",
    membershipId: clinic.membershipId,
  });

  beforeAll(async () => {
    clinic = await seedClinic();
    other = await seedClinic();
  });

  afterAll(async () => {
    await teardownClinic(other);
    await teardownClinic(clinic);
    await prisma.$disconnect();
  });

  test("a charge starts with the patient owing all of it", async () => {
    const written = await charge(clinic, 40_000);
    const split = await getPayerSplit(caller(), written.id);
    expect(split).toMatchObject({
      ok: true,
      value: { payerShareMinor: 0, patientShareMinor: 40_000 },
    });
  });

  test("setting the payer's share moves the patient's, and they sum to the charge", async () => {
    // **The guard.** Not "the split is right" — nothing here computes a rate — but that the two
    // halves account for the whole charge, always.
    const written = await charge(clinic, 40_000, 4_000);
    const result = await setPayerShare(caller(), written.id, 20_000);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const { subtotalMinor, discountMinor, payerShareMinor, patientShareMinor } = result.value;
    expect(payerShareMinor + patientShareMinor).toBe(subtotalMinor - discountMinor);
    expect({ payerShareMinor, patientShareMinor }).toEqual({
      payerShareMinor: 20_000,
      patientShareMinor: 16_000,
    });
  });

  test("a share larger than the charge has left is refused as a sentence", async () => {
    const written = await charge(clinic, 40_000, 4_000);
    // 36,000 remains after the discount. The service refuses before the constraint does, so the
    // desk gets a message rather than a constraint violation — the division `insurance.service.ts`
    // already uses for INVALID_WINDOW.
    const result = await setPayerShare(caller(), written.id, 36_001);
    expect(result).toEqual({
      ok: false,
      code: "SPLIT_EXCEEDS_CHARGE",
      params: { limit: 36_000, actual: 36_001 },
    });
  });

  test("and the database refuses it too, for anything that bypasses the service", async () => {
    // The service check makes it readable; this is what makes it impossible. A bulk update or a
    // future import never sees the former.
    const written = await charge(clinic, 40_000, 4_000);
    await expect(
      withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) =>
        tx.visitCharge.update({ where: { id: written.id }, data: { payerShareMinor: 36_001 } }),
      ),
    ).rejects.toThrow();
  });

  test("another clinic's charge is a 404, not a 403", async () => {
    const theirs = await charge(other, 10_000);
    const result = await setPayerShare(caller(), theirs.id, 1_000);
    expect(result).toEqual({ ok: false, code: "NOT_FOUND", params: { resource: "visit" } });

    // And nothing moved on the way to refusing.
    const unchanged = await withTenant(other.tenantId, actorFor(other.userId), async (tx) =>
      tx.visitCharge.findFirstOrThrow({ where: { id: theirs.id }, select: { payerShareMinor: true } }),
    );
    expect(unchanged.payerShareMinor).toBe(0);
  });

  test("the split names the insurer from the registry when the patient has one", async () => {
    // Read through the registry rather than the free-text insurer name, so a clinic that has
    // filled its registry sees one spelling rather than whichever the desk typed that day.
    await withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) => {
      const contact = await tx.contact.create({
        data: injected({ id: randomUUID(), phoneE164: "+201000000222" }),
        select: { id: true },
      });
      await tx.patient.update({ where: { id: clinic.patientId }, data: { contactId: contact.id } });
      const company = await tx.insuranceCompany.create({
        data: injected({ id: randomUUID(), name: "Registry Insurer", type: "INSURER" }),
        select: { id: true },
      });
      const policy = await tx.insurancePolicy.create({
        data: injected({
          id: randomUUID(),
          contactId: contact.id,
          companyId: company.id,
          insurerName: "typed differently by the desk",
          policyNumber: "P-900",
          policyholderName: "Holder",
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
    });

    const written = await charge(clinic, 10_000);
    const split = await getPayerSplit(caller(), written.id);
    expect(split).toMatchObject({ ok: true, value: { payerName: "Registry Insurer" } });
  });
});
