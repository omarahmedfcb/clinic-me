import { randomUUID } from "node:crypto";
import { prisma } from "../../src/prisma/client.ts";
import { injected } from "../../src/prisma/injected.ts";
import { withTenant } from "../../src/prisma/with-tenant.ts";
import { writeChargeForVisit } from "../../src/modules/billing/charge-from-visit.ts";
import { applyDiscount, getDeskCharge, recordPayment } from "../../src/modules/billing/desk.ts";
import { getCreditLedger } from "../../src/modules/billing/patient-credit.ts";
import { actorFor, seedClinic, teardownClinic, type ClinicFixture } from "./fixtures.ts";

/**
 * The desk — Phase 5 PR 9. Two guards the plan names, and one the founder added:
 *
 *   - a discount above the ceiling is refused to reception and allowed to an owner or admin;
 *   - **Q19** — a payment taken before the visit completes is accepted with no charge to point at,
 *     and settles the charge when it appears.
 *
 * R1's adjustments and R2's role rules live in `payments-and-pricing.integration.spec.ts`.
 */

const CASH = "CASH" as const;

async function visitReadyToComplete(
  clinic: ClinicFixture,
  priceOverride: number | null,
  source: "RECEPTION" | "DOCTOR" = "RECEPTION",
) {
  return withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) => {
    const appointment = await tx.appointment.create({
      data: injected({
        id: randomUUID(),
        patientId: clinic.patientId,
        doctorId: clinic.doctorId,
        serviceId: clinic.serviceId,
        scheduledStart: new Date("2027-07-05T09:00:00Z"),
        scheduledEnd: new Date("2027-07-05T09:30:00Z"),
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
    await tx.visitProcedure.create({
      data: injected({
        id: randomUUID(),
        visitId: visit.id,
        serviceId: clinic.serviceId,
        quantity: 1,
        unitPriceMinor: priceOverride,
        source,
        recordedByUserId: clinic.userId,
      }),
    });
    return { appointmentId: appointment.id, visitId: visit.id };
  });
}

const complete = async (clinic: ClinicFixture, visitId: string, appointmentId: string) =>
  withTenant(clinic.tenantId, actorFor(clinic.userId), (tx) =>
    writeChargeForVisit(tx, visitId, clinic.patientId, appointmentId, { actor: actorFor(clinic.userId) }),
  );

describe("billing", () => {
  let clinic: ClinicFixture;
  // Reception, which is who stands at the desk. R2 took `payments.record` away from an admin.
  const caller = () => ({
    tenantId: clinic.tenantId,
    actor: actorFor(clinic.userId),
    role: "RECEPTIONIST" as const,
    membershipId: clinic.membershipId,
  });

  beforeAll(async () => {
    clinic = await seedClinic();
    // A priced service, so a procedure with no override still produces a charge worth discounting.
    await withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) => {
      await tx.service.update({ where: { id: clinic.serviceId }, data: { priceMinor: 100_000 } });
    });
  });

  afterAll(async () => {
    await teardownClinic(clinic);
    await prisma.$disconnect();
  });

  describe("the desk", () => {
    test("the charge shows its lines, its ceiling and its balance", async () => {
      const { visitId, appointmentId } = await visitReadyToComplete(clinic, 100_000);
      const chargeId = await complete(clinic, visitId, appointmentId);
      const desk = await getDeskCharge(caller(), chargeId as string);

      expect(desk).toMatchObject({
        ok: true,
        value: { subtotalMinor: 100_000, patientShareMinor: 100_000, balanceMinor: 100_000 },
      });
      if (!desk.ok) return;
      expect(desk.value.lines).toHaveLength(1);
      // 10% of 100,000 is 10,000; the flat ceiling is 5,000. The desk is told the lower.
      expect(desk.value.discountCeilingMinor).toBe(5_000);
    });

    test("reception may discount within the ceiling and not above it", async () => {
      const { visitId, appointmentId } = await visitReadyToComplete(clinic, 100_000);
      const chargeId = (await complete(clinic, visitId, appointmentId)) as string;

      const within = await applyDiscount(
        { ...caller(), role: "RECEPTIONIST" },
        chargeId,
        { discountMinor: 5_000, reason: "goodwill" },
      );
      expect(within.ok).toBe(true);

      const above = await applyDiscount(
        { ...caller(), role: "RECEPTIONIST" },
        chargeId,
        { discountMinor: 20_000, reason: "goodwill" },
      );
      expect(above).toEqual({
        ok: false,
        code: "DISCOUNT_ABOVE_CEILING",
        params: { limit: 5_000, actual: 20_000 },
      });
    });

    test("an owner may discount above it, and is recorded as having allowed it", async () => {
      const { visitId, appointmentId } = await visitReadyToComplete(clinic, 100_000);
      const chargeId = (await complete(clinic, visitId, appointmentId)) as string;

      const result = await applyDiscount(
        { ...caller(), role: "OWNER" },
        chargeId,
        { discountMinor: 20_000, reason: "long-standing patient" },
      );
      expect(result.ok).toBe(true);

      const charge = await withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) =>
        tx.visitCharge.findFirstOrThrow({
          where: { id: chargeId },
          select: { discountMinor: true, discountAuthorisedByUserId: true },
        }),
      );
      expect(charge).toEqual({ discountMinor: 20_000, discountAuthorisedByUserId: clinic.userId });
    });

    test("part-payments by different methods each get a receipt, and the balance falls", async () => {
      const { visitId, appointmentId } = await visitReadyToComplete(clinic, 100_000);
      const chargeId = (await complete(clinic, visitId, appointmentId)) as string;

      for (const [amount, method] of [
        [40_000, CASH],
        [60_000, "INSTAPAY" as const],
      ] as const) {
        const receipt = await recordPayment(
          caller(),
          { chargeId, patientId: clinic.patientId, appointmentId, amountMinor: amount, method },
          new Date(),
        );
        expect(receipt.ok).toBe(true);
      }

      const desk = await getDeskCharge(caller(), chargeId);
      expect(desk).toMatchObject({ ok: true, value: { paidMinor: 100_000, balanceMinor: 0 } });
      if (!desk.ok) return;
      expect(desk.value.receipts).toHaveLength(2);
      // Every receipt carries its own number, which is what the printed sheet shows.
      expect(new Set(desk.value.receipts.map((r) => r.receiptNumber)).size).toBe(2);
      expect(desk.value.receipts.map((r) => r.method).sort()).toEqual(["CASH", "INSTAPAY"]);
    });

    /**
     * **R-A's first guard, 2026-09-14: desk overpayment → refused.**
     *
     * Ruling 5 had briefly made this money into credit. R-A reverses that half: credit is for money
     * the clinic could not refuse, and an overpayment at the desk is money it can. Refused by the
     * server, not only by the button — and nothing is written, so no credit appears either.
     */
    test("more than the balance is refused, and nothing is written", async () => {
      const { visitId, appointmentId } = await visitReadyToComplete(clinic, 100_000);
      const chargeId = (await complete(clinic, visitId, appointmentId)) as string;

      const tooMuch = await recordPayment(
        caller(),
        { chargeId, patientId: clinic.patientId, appointmentId, amountMinor: 150_000, method: CASH },
        new Date(),
      );
      expect(tooMuch).toMatchObject({
        ok: false,
        code: "PAYMENT_EXCEEDS_BALANCE",
        params: { limit: 100_000, actual: 150_000 },
      });

      const desk = await getDeskCharge(caller(), chargeId);
      expect(desk).toMatchObject({ ok: true, value: { paidMinor: 0, balanceMinor: 100_000 } });
      expect(desk.ok && desk.value.receipts).toHaveLength(0);

      // No receipt and no credit: a refusal that half-wrote would be worse than either outcome.
      const ledger = await getCreditLedger(caller(), clinic.patientId);
      expect(ledger).toMatchObject({ ok: true, value: { balanceMinor: 0, movements: [] } });
    });

    /** The boundary, on the safe side: exactly the balance is the ordinary act and must pass. */
    test("exactly the remaining balance is taken", async () => {
      const { visitId, appointmentId } = await visitReadyToComplete(clinic, 100_000);
      const chargeId = (await complete(clinic, visitId, appointmentId)) as string;

      const part = await recordPayment(
        caller(),
        { chargeId, patientId: clinic.patientId, appointmentId, amountMinor: 40_000, method: CASH },
        new Date(),
      );
      expect(part.ok).toBe(true);

      const rest = await recordPayment(
        caller(),
        { chargeId, patientId: clinic.patientId, appointmentId, amountMinor: 60_000, method: CASH },
        new Date(),
      );
      expect(rest.ok).toBe(true);
      expect(await getDeskCharge(caller(), chargeId)).toMatchObject({
        ok: true,
        value: { paidMinor: 100_000, balanceMinor: 0 },
      });
    });

    /** Money that names neither a charge nor an appointment is money no screen can ever show. */
    test("a payment against nothing at all is refused", async () => {
      const nothing = await recordPayment(
        caller(),
        { chargeId: null, patientId: clinic.patientId, appointmentId: null, amountMinor: 10_000, method: CASH },
        new Date(),
      );
      expect(nothing).toMatchObject({ ok: false, code: "NOT_FOUND" });
    });

    test("the desk carries what the printed invoice needs", async () => {
      const { visitId, appointmentId } = await visitReadyToComplete(clinic, 100_000);
      const chargeId = (await complete(clinic, visitId, appointmentId)) as string;
      const desk = await getDeskCharge(caller(), chargeId);
      expect(desk.ok).toBe(true);
      if (!desk.ok) return;
      // The file number is how a paper record is found again, and the date is what an invoice is.
      expect(desk.value.patientFileNumber).toBeGreaterThan(0);
      expect(desk.value.issuedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    test("Q19: a payment before the visit completes settles the charge when it appears", async () => {
      // **The founder's guard.** The money arrives at check-in, with no charge to point at.
      const { visitId, appointmentId } = await visitReadyToComplete(clinic, 100_000);

      const early = await recordPayment(
        caller(),
        {
          chargeId: null,
          patientId: clinic.patientId,
          appointmentId,
          amountMinor: 30_000,
          method: CASH,
        },
        new Date(),
      );
      expect(early.ok).toBe(true);

      // It is a receipt already: numbered, dated, and belonging to nothing.
      const unallocated = await withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) =>
        tx.payment.findFirstOrThrow({
          where: { appointmentId },
          select: { chargeId: true, receiptNumber: true },
        }),
      );
      expect(unallocated.chargeId).toBeNull();
      expect(unallocated.receiptNumber).toBeGreaterThan(0);

      // The visit completes. Nothing recalculates anything.
      const chargeId = (await complete(clinic, visitId, appointmentId)) as string;

      const desk = await getDeskCharge(caller(), chargeId);
      expect(desk).toMatchObject({
        ok: true,
        value: { paidMinor: 30_000, balanceMinor: 70_000 },
      });
      if (!desk.ok) return;
      expect(desk.value.receipts).toHaveLength(1);
    });

    test("a pre-payment for one appointment does not settle another", async () => {
      // Matched on the appointment, not the patient: somebody who pre-paid for Tuesday has not paid
      // for Thursday, and settling Thursday with Tuesday's money is a decision nobody asked for.
      const tuesday = await visitReadyToComplete(clinic, 100_000);
      await recordPayment(
        caller(),
        {
          chargeId: null,
          patientId: clinic.patientId,
          appointmentId: tuesday.appointmentId,
          amountMinor: 25_000,
          method: CASH,
        },
        new Date(),
      );

      const thursday = await visitReadyToComplete(clinic, 100_000);
      const thursdayCharge = (await complete(clinic, thursday.visitId, thursday.appointmentId)) as string;

      const desk = await getDeskCharge(caller(), thursdayCharge);
      expect(desk).toMatchObject({ ok: true, value: { paidMinor: 0, balanceMinor: 100_000 } });
    });
  });
});
