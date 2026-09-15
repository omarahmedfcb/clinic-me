import { randomUUID } from "node:crypto";
import { prisma } from "../../src/prisma/client.ts";
import { injected } from "../../src/prisma/injected.ts";
import { withTenant } from "../../src/prisma/with-tenant.ts";
import { actorFor, seedClinic, teardownClinic, type ClinicFixture } from "./fixtures.ts";

/**
 * The discount ceiling — Phase 5 PR 6, ruling 4.
 *
 * **The ceiling is a `CHECK`, not a DTO rule**, and that was ruled explicitly. The distinction is
 * the one this project keeps relearning: a service-layer check passes on a machine where the
 * migration was never applied, and it never sees the seed, direct SQL, or a future bulk import. So
 * every test here writes through the client, past any DTO, straight at the database.
 *
 * "10% or 50 EGP, whichever is lower" is **two settings and a `LEAST`**, not one number — the
 * founder's own words when he read the design back. Both halves are exercised below, including the
 * case where only one is set.
 */

async function charge(
  clinic: ClinicFixture,
  input: {
    subtotal: number;
    discount: number;
    authorisedBy?: string | null;
    ceilingPercent?: number | null;
    ceilingMinor?: number | null;
  },
) {
  return withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) => {
    const appointment = await tx.appointment.create({
      data: injected({
        id: randomUUID(),
        patientId: clinic.patientId,
        doctorId: clinic.doctorId,
        serviceId: clinic.serviceId,
        scheduledStart: new Date("2027-05-04T09:00:00Z"),
        scheduledEnd: new Date("2027-05-04T09:30:00Z"),
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
        subtotalMinor: input.subtotal,
        discountMinor: input.discount,
        discountReason: input.discount === 0 ? null : "goodwill",
        discountAuthorisedByUserId: input.authorisedBy ?? null,
        // Supplied explicitly where a test needs a specific ceiling; otherwise the trigger copies
        // the clinic's own settings, which is the path a real charge takes.
        ...(input.ceilingPercent === undefined ? {} : { ceilingPercentSnapshot: input.ceilingPercent }),
        ...(input.ceilingMinor === undefined ? {} : { ceilingMinorSnapshot: input.ceilingMinor }),
      }),
      select: { id: true, ceilingPercentSnapshot: true, ceilingMinorSnapshot: true },
    });
  });
}

describe("the discount ceiling", () => {
  let clinic: ClinicFixture;

  beforeAll(async () => {
    clinic = await seedClinic();
  });

  afterAll(async () => {
    await teardownClinic(clinic);
    await prisma.$disconnect();
  });

  test("a new charge snapshots the clinic's ceiling without being told it", async () => {
    // The snapshot is what lets a CHECK enforce a cross-table rule at all, and what stops raising
    // the ceiling next year from retroactively authorising a discount nobody approved.
    const written = await charge(clinic, { subtotal: 100_000, discount: 0 });
    expect(written).toMatchObject({ ceilingPercentSnapshot: 10, ceilingMinorSnapshot: 5_000 });
  });

  test("the lower of the two wins — the flat amount, on a large invoice", async () => {
    // 10% of 100,000 is 10,000; the flat ceiling is 5,000. `LEAST` takes 5,000, which is the whole
    // point of having both: a percentage of a very large invoice becomes a discount nobody meant
    // to authorise.
    await expect(charge(clinic, { subtotal: 100_000, discount: 5_000 })).resolves.toBeDefined();
    await expect(charge(clinic, { subtotal: 100_000, discount: 5_001 })).rejects.toThrow();
  });

  test("the lower of the two wins — the percentage, on a small invoice", async () => {
    // 10% of 20,000 is 2,000, below the 5,000 flat ceiling, so the percentage is what binds.
    await expect(charge(clinic, { subtotal: 20_000, discount: 2_000 })).resolves.toBeDefined();
    await expect(charge(clinic, { subtotal: 20_000, discount: 2_100 })).rejects.toThrow();
  });

  test("a clinic that sets only one half gets exactly that half", async () => {
    // `LEAST` ignores nulls. A clinic with no flat ceiling is bound by its percentage alone.
    await expect(
      charge(clinic, { subtotal: 100_000, discount: 9_000, ceilingPercent: 10, ceilingMinor: null }),
    ).resolves.toBeDefined();
    await expect(
      charge(clinic, { subtotal: 100_000, discount: 11_000, ceilingPercent: 10, ceilingMinor: null }),
    ).rejects.toThrow();
  });

  test("above the ceiling is allowed when somebody is named as authorising it", async () => {
    // Ruling 4's other half: owner and admin may exceed it. The column records *who*, because "who
    // allowed this" is the question anyone looking at a discounted invoice actually asks.
    await expect(
      charge(clinic, { subtotal: 20_000, discount: 15_000, authorisedBy: clinic.userId }),
    ).resolves.toBeDefined();
  });

  test("a charge written before the clinic had a ceiling is not judged by it", async () => {
    // Both snapshots null reads as "no ceiling applied at the time", which is exactly true of every
    // charge that existed before this migration. Backfilling today's ceiling onto them would judge
    // history by a rule that did not exist — and it failed on the first attempt, because the seeded
    // data carries discounts of up to 30%.
    // Such a row cannot be created through the normal path — the trigger always stamps a new charge
    // with the clinic's ceiling, which is correct — so this reaches the state the way it actually
    // exists: by UPDATE, which the CHECK is evaluated on too.
    const written = await charge(clinic, { subtotal: 20_000, discount: 0 });
    const updated = await withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) =>
      tx.$executeRaw`UPDATE visit_charges
            SET ceiling_percent_snapshot = NULL,
                ceiling_minor_snapshot = NULL,
                discount_minor = 15000,
                discount_reason = 'predates the ceiling'
          WHERE id = ${written.id}::uuid`,
    );
    expect(updated).toBe(1);
  });

  test("the tenant's own settings are range-checked", async () => {
    // A percentage above 100 is not a ceiling, it is a typo that would authorise anything.
    await expect(
      withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) =>
        tx.tenant.update({
          where: { id: clinic.tenantId },
          data: { discountCeilingPercent: 150 },
        }),
      ),
    ).rejects.toThrow();
  });
});
