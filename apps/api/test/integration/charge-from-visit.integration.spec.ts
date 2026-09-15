import { randomUUID } from "node:crypto";
import { prisma } from "../../src/prisma/client.ts";
import { injected } from "../../src/prisma/injected.ts";
import { withTenant } from "../../src/prisma/with-tenant.ts";
import { writeChargeForVisit } from "../../src/modules/billing/charge-from-visit.ts";
import { actorFor, seedClinic, teardownClinic, type ClinicFixture } from "./fixtures.ts";

/**
 * Completion writes the charge — Phase 5 PR 4, the ruling that closed `PHASE-5-PLAN.md` §2.
 *
 * **The assertion that matters is the snapshot one.** A charge line that re-joins `services` looks
 * correct on the day it is written and rewrites every historical invoice the first time an admin
 * edits a price — unrecoverably, because the old price was never stored anywhere. That is the same
 * failure `appointments.quoted_price_minor` was added to prevent, one table along.
 */

async function completedVisitWithProcedures(
  clinic: ClinicFixture,
  procedures: { priceOverride: number | null }[],
) {
  return withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) => {
    const appointment = await tx.appointment.create({
      data: injected({
        id: randomUUID(),
        patientId: clinic.patientId,
        doctorId: clinic.doctorId,
        serviceId: clinic.serviceId,
        scheduledStart: new Date("2026-04-06T09:00:00Z"),
        scheduledEnd: new Date("2026-04-06T09:30:00Z"),
        status: "COMPLETED",
        source: "RECEPTION",
        createdBy: clinic.userId,
        updatedBy: clinic.userId,
        allowOverlap: true,
      }),
      select: { id: true, patientId: true },
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

    for (const [index, procedure] of procedures.entries()) {
      await tx.visitProcedure.create({
        data: injected({
          id: randomUUID(),
          visitId: visit.id,
          serviceId: clinic.serviceId,
          quantity: 1,
          unitPriceMinor: procedure.priceOverride,
          // DOCTOR rather than RECEPTION: a partial unique index allows only one RECEPTION line
          // per visit, and these fixtures record several.
          source: index === 0 ? "RECEPTION" : "DOCTOR",
          recordedByUserId: clinic.userId,
        }),
      });
    }

    return { visitId: visit.id, patientId: appointment.patientId, appointmentId: appointment.id };
  });
}

const readCharge = async (clinic: ClinicFixture, visitId: string) =>
  withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) =>
    tx.visitCharge.findFirstOrThrow({
      where: { visitId },
      select: {
        subtotalMinor: true,
        status: true,
        lines: {
          select: { nameSnapshot: true, unitPriceMinor: true, quantity: true, source: true },
          orderBy: { createdAt: "asc" },
        },
      },
    }),
  );

describe("the charge a completed visit produces", () => {
  let clinic: ClinicFixture;

  beforeAll(async () => {
    clinic = await seedClinic();
  });

  afterAll(async () => {
    await teardownClinic(clinic);
    await prisma.$disconnect();
  });

  test("each procedure becomes a line, and the subtotal is their sum", async () => {
    const { visitId, patientId, appointmentId } = await completedVisitWithProcedures(clinic, [
      { priceOverride: 20_000 },
      { priceOverride: 5_000 },
    ]);
    await withTenant(clinic.tenantId, actorFor(clinic.userId), (tx) =>
      writeChargeForVisit(tx, visitId, patientId, appointmentId, { actor: actorFor(clinic.userId) }),
    );

    const charge = await readCharge(clinic, visitId);
    expect(charge.subtotalMinor).toBe(25_000);
    expect(charge.lines.map((line) => line.unitPriceMinor)).toEqual([20_000, 5_000]);
    expect(charge.lines.every((line) => line.source === "CATALOGUE")).toBe(true);
  });

  test("the line does not move when the service's price changes", async () => {
    // **The guard.** Written as a before-and-after rather than a single assertion, so a failure
    // says which of the two halves broke.
    const { visitId, patientId, appointmentId } = await completedVisitWithProcedures(clinic, [
      { priceOverride: null },
    ]);
    const priceThen = await withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) => {
      const service = await tx.service.findFirstOrThrow({
        where: { id: clinic.serviceId },
        select: { priceMinor: true },
      });
      await writeChargeForVisit(tx, visitId, patientId, appointmentId, { actor: actorFor(clinic.userId) });
      return service.priceMinor;
    });

    const before = await readCharge(clinic, visitId);
    expect(before.lines[0]?.unitPriceMinor).toBe(priceThen);

    await withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) => {
      await tx.service.update({
        where: { id: clinic.serviceId },
        data: { priceMinor: priceThen + 99_000 },
      });
    });

    const after = await readCharge(clinic, visitId);
    expect({ price: after.lines[0]?.unitPriceMinor, subtotal: after.subtotalMinor }).toEqual({
      price: priceThen,
      subtotal: priceThen,
    });
  });

  test("the name is frozen too, not just the price", async () => {
    const { visitId, patientId, appointmentId } = await completedVisitWithProcedures(clinic, [
      { priceOverride: 1_000 },
    ]);
    const nameThen = await withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) => {
      const service = await tx.service.findFirstOrThrow({
        where: { id: clinic.serviceId },
        select: { nameAr: true },
      });
      await writeChargeForVisit(tx, visitId, patientId, appointmentId, { actor: actorFor(clinic.userId) });
      return service.nameAr;
    });

    // The snapshot is the service's name **at write time**, not merely a value that never changes:
    // a constant string would satisfy "stable" and name the wrong thing on every receipt.
    expect((await readCharge(clinic, visitId)).lines[0]?.nameSnapshot).toBe(nameThen);

    await withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) => {
      await tx.service.update({ where: { id: clinic.serviceId }, data: { nameAr: "اسم جديد تمامًا" } });
    });

    // A renamed service must not rewrite what a patient was told they were charged for.
    expect((await readCharge(clinic, visitId)).lines[0]?.nameSnapshot).toBe(nameThen);
  });

  test("a procedure with no price is written at zero rather than refused", async () => {
    // The invoice proceeds and settles. A refusal here would block completion on a price the
    // doctor may not know yet, which is a real thing at a desk.
    await withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) => {
      await tx.service.update({ where: { id: clinic.serviceId }, data: { priceMinor: 0 } });
    });

    const { visitId, patientId, appointmentId } = await completedVisitWithProcedures(clinic, [
      { priceOverride: null },
    ]);
    await withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) => {
      await writeChargeForVisit(tx, visitId, patientId, appointmentId, { actor: actorFor(clinic.userId) });
    });

    const charge = await readCharge(clinic, visitId);
    expect(charge.lines[0]?.unitPriceMinor).toBe(0);
    expect(charge.status).toBe("OPEN");
  });

  test("writing twice leaves one charge", async () => {
    // Completion is compare-and-set and cannot run twice, but a second charge would be a duplicate
    // bill — worth being certain about rather than reasoning about.
    const { visitId, patientId, appointmentId } = await completedVisitWithProcedures(clinic, [
      { priceOverride: 7_000 },
    ]);
    const first = await withTenant(clinic.tenantId, actorFor(clinic.userId), (tx) =>
      writeChargeForVisit(tx, visitId, patientId, appointmentId, { actor: actorFor(clinic.userId) }),
    );
    const second = await withTenant(clinic.tenantId, actorFor(clinic.userId), (tx) =>
      writeChargeForVisit(tx, visitId, patientId, appointmentId, { actor: actorFor(clinic.userId) }),
    );
    expect(second).toBe(first);

    const count = await withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) =>
      tx.visitCharge.count({ where: { visitId } }),
    );
    expect(count).toBe(1);
  });
});
