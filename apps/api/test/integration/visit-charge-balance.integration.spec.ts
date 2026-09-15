import { randomUUID } from "node:crypto";
import { prisma } from "../../src/prisma/client.ts";
import { injected } from "../../src/prisma/injected.ts";
import { withTenant } from "../../src/prisma/with-tenant.ts";
import { actorFor, seedClinic, teardownClinic, type ClinicFixture } from "./fixtures.ts";

/**
 * The charge balance — Phase 5 PR 3, ruling 3, D7 as amended 2026-09-03.
 *
 * **The balance is a view, and the point of a view is that nothing can write it.** A stored column
 * maintained by a trigger would match D7's letter and reintroduce exactly the drift D7 exists to
 * prevent, because a trigger can be bypassed by a bulk operation. Application-side summation is the
 * thing D7 forbids outright.
 *
 * So the assertions are: the balance moves when its inputs move, with no application code involved;
 * and it cannot be written to at all.
 */

async function chargedVisit(clinic: ClinicFixture, subtotal: number, discount = 0, payer = 0) {
  return withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) => {
    const appointment = await tx.appointment.create({
      data: injected({
        id: randomUUID(),
        patientId: clinic.patientId,
        doctorId: clinic.doctorId,
        serviceId: clinic.serviceId,
        scheduledStart: new Date("2026-03-02T09:00:00Z"),
        scheduledEnd: new Date("2026-03-02T09:30:00Z"),
        status: "COMPLETED",
        source: "RECEPTION",
        createdBy: clinic.userId,
        updatedBy: clinic.userId,
        // Several fixtures share an instant for one doctor; `allow_overlap` is the flag the
        // exclusion constraint itself exempts.
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
    const charge = await tx.visitCharge.create({
      data: injected({
        id: randomUUID(),
        visitId: visit.id,
        patientId: clinic.patientId,
        subtotalMinor: subtotal,
        discountMinor: discount,
        // A discount with no reason is refused by the charge's own CHECK -- which the last test
        // in this file asserts -- so the fixtures supply one whenever they discount.
        discountReason: discount === 0 ? null : "goodwill",
        payerShareMinor: payer,
      }),
      select: { id: true },
    });
    return { appointmentId: appointment.id, visitId: visit.id, chargeId: charge.id };
  });
}

const balance = async (clinic: ClinicFixture, chargeId: string) =>
  withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) => {
    const rows = await tx.$queryRaw<
      { patient_share_minor: number; paid_minor: number; balance_minor: number }[]
    >`SELECT patient_share_minor, paid_minor, balance_minor
        FROM visit_charge_balances WHERE charge_id = ${chargeId}::uuid`;
    return rows[0];
  });

describe("the visit charge balance view", () => {
  let clinic: ClinicFixture;
  let other: ClinicFixture;

  beforeAll(async () => {
    clinic = await seedClinic();
    other = await seedClinic();
  });

  afterAll(async () => {
    await teardownClinic(other);
    await teardownClinic(clinic);
    await prisma.$disconnect();
  });

  test("the patient's share is subtotal less discount less the payer's share", async () => {
    const { chargeId } = await chargedVisit(clinic, 50_000, 5_000, 20_000);
    expect(await balance(clinic, chargeId)).toEqual({
      patient_share_minor: 25_000,
      paid_minor: 0,
      balance_minor: 25_000,
    });
  });

  test("a payment written directly moves the balance, with no application code involved", async () => {
    // This is the whole claim of ruling 3. The payment is inserted with the client, nothing
    // recalculates anything, and the view has already changed.
    const { visitId, appointmentId, chargeId } = await chargedVisit(clinic, 30_000);
    expect((await balance(clinic, chargeId))?.balance_minor).toBe(30_000);

    await withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) => {
      await tx.payment.create({
        data: injected({
          id: randomUUID(),
          patientId: clinic.patientId,
          appointmentId,
          visitId,
          amountMinor: 12_000,
          method: "CASH",
          status: "PARTIAL",
        }),
      });
    });

    expect(await balance(clinic, chargeId)).toEqual({
      patient_share_minor: 30_000,
      paid_minor: 12_000,
      balance_minor: 18_000,
    });
  });

  test("two part-payments sum, which one row on `payments` could never represent", async () => {
    const { visitId, appointmentId, chargeId } = await chargedVisit(clinic, 40_000);
    await withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) => {
      for (const [amount, method] of [
        [15_000, "CASH"],
        [25_000, "INSTAPAY"],
      ] as const) {
        await tx.payment.create({
          data: injected({
            id: randomUUID(),
            patientId: clinic.patientId,
            appointmentId,
            visitId,
            amountMinor: amount,
            method,
            status: "PAID",
          }),
        });
      }
    });

    expect(await balance(clinic, chargeId)).toEqual({
      patient_share_minor: 40_000,
      paid_minor: 40_000,
      balance_minor: 0,
    });
  });

  test("the balance cannot be written", async () => {
    // A stored column maintained by a trigger matches D7's letter and can be bypassed by a bulk
    // operation. A view has no storage to bypass, and Postgres says so.
    const { chargeId } = await chargedVisit(clinic, 10_000);
    await expect(
      withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) => {
        await tx.$executeRaw`UPDATE visit_charge_balances SET balance_minor = 0 WHERE charge_id = ${chargeId}::uuid`;
      }),
    ).rejects.toThrow();
  });

  test("the view does not leak another clinic's charges", async () => {
    // **`security_invoker = true` is what this asserts.** Without it the view runs with its
    // owner's rights — the migration superuser — and every clinic's rows come back regardless of
    // `app.current_tenant_id`, which would be a tenant-isolation breach wearing a view's clothes.
    const theirs = await chargedVisit(other, 99_000);

    const seen = await withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) =>
      tx.$queryRaw<{ charge_id: string }[]>`
        SELECT charge_id FROM visit_charge_balances WHERE charge_id = ${theirs.chargeId}::uuid`,
    );
    expect(seen).toEqual([]);
  });

  test("a discount larger than the subtotal is refused by the database", async () => {
    // Keeping the patient's share at zero or above is what stops a screen having to decide what a
    // negative amount due means.
    await expect(chargedVisit(clinic, 10_000, 20_000)).rejects.toThrow();
  });

  test("a discount with no reason is refused", async () => {
    await expect(
      withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) => {
        const { visitId } = await chargedVisit(clinic, 10_000);
        await tx.visitCharge.update({
          where: { visitId },
          data: { discountMinor: 1_000, discountReason: null },
        });
      }),
    ).rejects.toThrow();
  });
});
