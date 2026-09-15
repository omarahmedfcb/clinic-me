import { randomUUID } from "node:crypto";
import { prisma } from "../../src/prisma/client.ts";
import { injected } from "../../src/prisma/injected.ts";
import { withTenant } from "../../src/prisma/with-tenant.ts";
import { changeAppointmentStatus } from "../../src/modules/appointments/appointments.service.ts";
import { writeChargeForVisit } from "../../src/modules/billing/charge-from-visit.ts";
import { recordPayment } from "../../src/modules/billing/desk.ts";
import {
  applyCreditToCharge,
  getCreditLedger,
  refundCredit,
} from "../../src/modules/billing/patient-credit.ts";
import { actorFor, seedClinic, teardownClinic, type ClinicFixture } from "./fixtures.ts";

/**
 * Clinic credit — ruling 5 as amended by R-A, 2026-09-14.
 *
 * **Credit arises only where refusing the money is impossible**: a pre-payment larger than the bill
 * at completion, and a pre-paid appointment that is cancelled or abandoned. An overpayment at the
 * desk is refused instead, which `desk.integration.spec.ts` holds. Credit settles the next charge,
 * is refundable on request with a reason, and is never forfeited — the last of those cannot be shown
 * by a happy path, so it is proven the other way: nothing edits, deletes, or overspends a movement.
 */

describe("clinic credit", () => {
  let clinic: ClinicFixture;

  const reception = () => ({
    tenantId: clinic.tenantId,
    actor: actorFor(clinic.userId),
    role: "RECEPTIONIST" as const,
    membershipId: clinic.membershipId,
  });

  /**
   * A visit with a charge of `subtotalMinor`, which is what a patient owes before anything else.
   *
   * Each one takes its own slot: `no_double_booking` is a real exclusion constraint and two fixtures
   * sharing an hour is a collision, not a test failure worth debugging twice.
   */
  let nextSlotHour = 0;

  /** A distinct half-hour per fixture, rolling into the next day rather than past midnight. */
  const slotStart = (n: number): Date =>
    new Date(
      `2027-04-${String(1 + Math.floor(n / 10)).padStart(2, "0")}T${String(8 + (n % 10)).padStart(2, "0")}:00:00Z`,
    );

  async function chargeFor(subtotalMinor: number): Promise<{ chargeId: string; visitId: string }> {
    const start = slotStart(nextSlotHour++);
    return withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) => {
      const appointmentId = randomUUID();
      await tx.appointment.create({
        data: injected({
          id: appointmentId,
          patientId: clinic.patientId,
          doctorId: clinic.doctorId,
          serviceId: clinic.serviceId,
          scheduledStart: start,
          scheduledEnd: new Date(start.getTime() + 30 * 60_000),
          status: "COMPLETED",
          source: "RECEPTION",
          createdBy: clinic.userId,
          updatedBy: clinic.userId,
        }),
      });

      const visitId = randomUUID();
      await tx.visit.create({
        data: injected({
          id: visitId,
          appointmentId,
          patientId: clinic.patientId,
          doctorId: clinic.doctorId,
          status: "COMPLETED",
          createdBy: clinic.userId,
        }),
      });

      const chargeId = randomUUID();
      await tx.visitCharge.create({
        data: injected({ id: chargeId, visitId, patientId: clinic.patientId, subtotalMinor }),
      });
      return { chargeId, visitId };
    });
  }

  const balanceOf = async (): Promise<number> => {
    const result = await getCreditLedger(reception(), clinic.patientId);
    return result.ok ? result.value.balanceMinor : -1;
  };

  /**
   * Credit for a test that needs some to spend, through a sanctioned origin: a pre-payment of
   * `10_000 + amountMinor` against a visit that bills 10,000, so exactly `amountMinor` is credited.
   *
   * Each test makes its own rather than relying on an earlier one's leftovers: three separate specs
   * in this session broke because a test depended on a balance another test happened to leave.
   */
  const giveCredit = async (amountMinor: number): Promise<void> => {
    const { visitId, appointmentId } = await visitReadyToComplete(nextSlotHour++, 10_000);
    const paid = await recordPayment(
      reception(),
      {
        chargeId: null,
        patientId: clinic.patientId,
        appointmentId,
        amountMinor: 10_000 + amountMinor,
        method: "CASH",
      },
      new Date(),
    );
    expect(paid.ok).toBe(true);
    await completeVisit(visitId, appointmentId);
  };

  /**
   * A visit with one procedure, ready for completion to price it — the real path, unlike
   * `chargeFor`, which writes a charge directly because those tests are about the ledger.
   */
  async function visitReadyToComplete(
    slot: number,
    priceMinor: number,
  ): Promise<{ visitId: string; appointmentId: string }> {
    return withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) => {
      const start = slotStart(slot);
      const appointment = await tx.appointment.create({
        data: injected({
          id: randomUUID(),
          patientId: clinic.patientId,
          doctorId: clinic.doctorId,
          serviceId: clinic.serviceId,
          scheduledStart: start,
          scheduledEnd: new Date(start.getTime() + 30 * 60_000),
          status: "COMPLETED",
          source: "RECEPTION",
          createdBy: clinic.userId,
          updatedBy: clinic.userId,
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
          unitPriceMinor: priceMinor,
          source: "RECEPTION",
          recordedByUserId: clinic.userId,
        }),
      });
      return { visitId: visit.id, appointmentId: appointment.id };
    });
  }

  const completeVisit = async (visitId: string, appointmentId: string): Promise<string> =>
    withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) => {
      const chargeId = await writeChargeForVisit(tx, visitId, clinic.patientId, appointmentId, {
        actor: actorFor(clinic.userId),
      });
      return chargeId as string;
    });

  const chargeBalance = async (chargeId: string): Promise<number> =>
    withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) => {
      const rows = await tx.$queryRaw<{ balance_minor: number }[]>`
        SELECT balance_minor FROM visit_charge_balances WHERE charge_id = ${chargeId}::uuid`;
      return rows[0]?.balance_minor ?? 0;
    });

  beforeAll(async () => {
    clinic = await seedClinic();
  });

  afterAll(async () => {
    await teardownClinic(clinic);
    await prisma.$disconnect();
  });

  test("an overpayment at the desk is refused, and makes no credit — R-A", async () => {
    // This was briefly credit under ruling 5. R-A puts the refusal back: the ledger must not move.
    const { chargeId } = await chargeFor(30_000);
    const before = await balanceOf();

    const result = await recordPayment(
      reception(),
      { chargeId, patientId: clinic.patientId, appointmentId: null, amountMinor: 50_000, method: "CASH" },
      new Date(),
    );
    expect(result).toMatchObject({ ok: false, code: "PAYMENT_EXCEEDS_BALANCE" });

    expect(await balanceOf()).toBe(before);
    expect(await chargeBalance(chargeId)).toBe(30_000);
  });

  test("credit settles a later charge, and can be spent in parts", async () => {
    const { chargeId } = await chargeFor(12_000);
    await giveCredit(12_000);
    const before = await balanceOf();
    expect(before).toBeGreaterThanOrEqual(12_000);

    const first = await applyCreditToCharge(reception(), { chargeId, amountMinor: 5_000 });
    expect(first.ok).toBe(true);
    expect(await chargeBalance(chargeId)).toBe(7_000);

    // Partial application is the reason this is a ledger rather than an unallocated payment row:
    // one payment row has one amount and one charge, and cannot be spent twice.
    const second = await applyCreditToCharge(reception(), { chargeId, amountMinor: 7_000 });
    expect(second.ok).toBe(true);
    expect(await chargeBalance(chargeId)).toBe(0);
    expect(await balanceOf()).toBe(before - 12_000);
  });

  test("spending more than the balance is refused with the balance in the sentence", async () => {
    const { chargeId } = await chargeFor(999_999);
    const available = await balanceOf();

    const result = await applyCreditToCharge(reception(), { chargeId, amountMinor: available + 1 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("INSUFFICIENT_CREDIT");
    expect(result.params).toMatchObject({ limit: available, actual: available + 1 });
    expect(await balanceOf()).toBe(available);
  });

  test("credit applied past what the bill owes is refused too — R-A reaches this by the same rule", async () => {
    const { chargeId } = await chargeFor(5_000);
    await giveCredit(80_000);
    const available = await balanceOf();

    // There is plenty of credit; the bill is the limit, and spending past it would take the charge
    // below zero — exactly what the desk's refusal exists to prevent, through the other button.
    const result = await applyCreditToCharge(reception(), { chargeId, amountMinor: 6_000 });
    expect(result).toMatchObject({
      ok: false,
      code: "PAYMENT_EXCEEDS_BALANCE",
      params: { limit: 5_000, actual: 6_000 },
    });
    expect(await balanceOf()).toBe(available);
    expect(await chargeBalance(chargeId)).toBe(5_000);
  });

  test("a refund needs a reason, and the reason is kept", async () => {
    const blank = await refundCredit(reception(), {
      patientId: clinic.patientId,
      amountMinor: 1_000,
      reason: "   ",
    });
    expect(blank.ok).toBe(false);
    if (blank.ok) return;
    expect(blank.code).toBe("REFUND_REASON_REQUIRED");

    const given = await refundCredit(reception(), {
      patientId: clinic.patientId,
      amountMinor: 1_000,
      reason: "المريضة طلبت استرداد الرصيد",
    });
    expect(given.ok).toBe(true);

    const ledger = await getCreditLedger(reception(), clinic.patientId);
    expect(ledger.ok).toBe(true);
    if (!ledger.ok) return;
    const refunded = ledger.value.movements.find((row) => row.movement === "REFUNDED");
    expect(refunded?.reason).toBe("المريضة طلبت استرداد الرصيد");
    expect(refunded?.actorName.length ?? 0).toBeGreaterThan(0);
  });

  test("the ledger reads as a history, newest first, with each movement's counterpart", async () => {
    const ledger = await getCreditLedger(reception(), clinic.patientId);
    expect(ledger.ok).toBe(true);
    if (!ledger.ok) return;

    expect(ledger.value.movements.length).toBeGreaterThan(3);
    expect(new Set(ledger.value.movements.map((row) => row.movement))).toEqual(
      new Set(["CREDIT", "APPLIED", "REFUNDED"]),
    );
    // A credit says which receipt it came from; an application says which bill it settled.
    expect(ledger.value.movements.some((row) => row.movement === "CREDIT" && row.receiptNumber !== null)).toBe(true);
    expect(ledger.value.movements.some((row) => row.movement === "APPLIED" && row.appliedChargeId !== null)).toBe(true);
    // The totals reconcile with the movements, because both come from the same view.
    expect(ledger.value.balanceMinor).toBe(
      ledger.value.creditedMinor - ledger.value.appliedMinor - ledger.value.refundedMinor,
    );
  });

  /**
   * **A pre-payment larger than the bill.** The hole that predated clinic credit: the desk's old
   * overpayment refusal only guarded payments made against an existing charge, and money taken at
   * check-in has no charge to be refused against — so it attached in full at completion and drove
   * the balance negative.
   */
  describe("a pre-payment above the bill", () => {
    test("credits the excess at completion instead of leaving a negative balance", async () => {
      const hour = nextSlotHour++;
      const { visitId, appointmentId } = await visitReadyToComplete(hour, 60_000);

      // 100 taken at check-in, with no charge to point at — Q19's case.
      const early = await recordPayment(
        reception(),
        { chargeId: null, patientId: clinic.patientId, appointmentId, amountMinor: 100_000, method: "CASH" },
        new Date(),
      );
      expect(early.ok).toBe(true);

      const before = await balanceOf();
      const chargeId = await completeVisit(visitId, appointmentId);

      // The bill is settled exactly, never below zero.
      expect(await chargeBalance(chargeId)).toBe(0);
      // And the 40 the patient overpaid is theirs, as credit, rather than a negative number on the
      // clinic's own bill that no screen has a sentence for.
      expect(await balanceOf()).toBe(before + 40_000);
    });

    test("a pre-payment that matches the bill credits nothing", async () => {
      // The control: the ordinary case must not start manufacturing credit.
      const hour = nextSlotHour++;
      const { visitId, appointmentId } = await visitReadyToComplete(hour, 60_000);
      await recordPayment(
        reception(),
        { chargeId: null, patientId: clinic.patientId, appointmentId, amountMinor: 60_000, method: "CASH" },
        new Date(),
      );

      const before = await balanceOf();
      const chargeId = await completeVisit(visitId, appointmentId);

      expect(await chargeBalance(chargeId)).toBe(0);
      expect(await balanceOf()).toBe(before);
    });
  });

  /**
   * **R-A's second origin: a pre-paid appointment that never becomes a bill.**
   *
   * Cancelled or abandoned, the money was taken against something that will now never be invoiced —
   * so there is nothing to refuse and nothing to attach it to, and it is the patient's.
   */
  describe("a pre-paid appointment that ends without a bill", () => {
    /** A booked appointment with `amountMinor` already taken against it, and nothing else. */
    async function prePaid(amountMinor: number): Promise<string> {
      const start = slotStart(nextSlotHour++);
      const appointmentId = await withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) => {
        const appointment = await tx.appointment.create({
          data: injected({
            id: randomUUID(),
            patientId: clinic.patientId,
            doctorId: clinic.doctorId,
            serviceId: clinic.serviceId,
            scheduledStart: start,
            scheduledEnd: new Date(start.getTime() + 30 * 60_000),
            status: "BOOKED",
            source: "RECEPTION",
            createdBy: clinic.userId,
            updatedBy: clinic.userId,
          }),
          select: { id: true },
        });
        return appointment.id;
      });

      const paid = await recordPayment(
        reception(),
        { chargeId: null, patientId: clinic.patientId, appointmentId, amountMinor, method: "CASH" },
        new Date(),
      );
      expect(paid.ok).toBe(true);
      return appointmentId;
    }

    test("a cancellation credits the pre-payment in full", async () => {
      const appointmentId = await prePaid(45_000);
      const before = await balanceOf();

      const cancelled = await changeAppointmentStatus(reception(), appointmentId, "CANCEL", {
        reason: "المريضة اعتذرت",
        now: new Date(),
      });
      expect(cancelled).toMatchObject({ ok: true, status: "CANCELLED" });

      expect(await balanceOf()).toBe(before + 45_000);
      const ledger = await getCreditLedger(reception(), clinic.patientId);
      expect(ledger.ok).toBe(true);
      if (!ledger.ok) return;
      // A code, not a sentence: the ledger is read in Arabic and the reason is translated there.
      expect(ledger.value.movements[0]).toMatchObject({
        movement: "CREDIT",
        amountMinor: 45_000,
        reason: "APPOINTMENT_CANCELLED",
      });
      expect(ledger.value.movements[0]?.receiptNumber).toBeGreaterThan(0);
    });

    test("a no-show credits the pre-payment in full", async () => {
      const appointmentId = await prePaid(25_000);
      const before = await balanceOf();

      // Long after the grace period, which `transition()` enforces from the tenant's own setting.
      const absent = await changeAppointmentStatus(reception(), appointmentId, "MARK_NO_SHOW", {
        now: new Date("2027-05-01T12:00:00Z"),
      });
      expect(absent).toMatchObject({ ok: true, status: "NO_SHOW" });

      expect(await balanceOf()).toBe(before + 25_000);
      const ledger = await getCreditLedger(reception(), clinic.patientId);
      expect(ledger.ok && ledger.value.movements[0]).toMatchObject({
        movement: "CREDIT",
        reason: "APPOINTMENT_NOT_ATTENDED",
      });
    });

    test("a cancellation with nothing pre-paid credits nothing", async () => {
      // The control: cancelling must not start manufacturing credit out of an empty appointment.
      const start = slotStart(nextSlotHour++);
      const appointmentId = await withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) => {
        const appointment = await tx.appointment.create({
          data: injected({
            id: randomUUID(),
            patientId: clinic.patientId,
            doctorId: clinic.doctorId,
            serviceId: clinic.serviceId,
            scheduledStart: start,
            scheduledEnd: new Date(start.getTime() + 30 * 60_000),
            status: "BOOKED",
            source: "RECEPTION",
            createdBy: clinic.userId,
            updatedBy: clinic.userId,
          }),
          select: { id: true },
        });
        return appointment.id;
      });

      const before = await balanceOf();
      const cancelled = await changeAppointmentStatus(reception(), appointmentId, "CANCEL", {
        reason: "تغيّر الموعد",
        now: new Date(),
      });
      expect(cancelled).toMatchObject({ ok: true });
      expect(await balanceOf()).toBe(before);
    });
  });

  describe("never forfeited, and never overspent — in the database", () => {
    test("a movement cannot be edited", async () => {
      const row = await withTenant(clinic.tenantId, actorFor(clinic.userId), (tx) =>
        tx.patientCredit.findFirstOrThrow({ where: { movement: "CREDIT" }, select: { id: true } }),
      );
      const raw = withTenant(clinic.tenantId, actorFor(clinic.userId), (tx) =>
        tx.patientCredit.update({ where: { id: row.id }, data: { amountMinor: 1 } }),
      );
      await expect(raw).rejects.toThrow(/append-only/i);
    });

    test("a movement cannot be deleted, which is what 'never forfeited' rests on", async () => {
      const row = await withTenant(clinic.tenantId, actorFor(clinic.userId), (tx) =>
        tx.patientCredit.findFirstOrThrow({ where: { movement: "CREDIT" }, select: { id: true } }),
      );
      const raw = withTenant(clinic.tenantId, actorFor(clinic.userId), (tx) =>
        tx.patientCredit.delete({ where: { id: row.id } }),
      );
      await expect(raw).rejects.toThrow(/append-only/i);
    });

    test("the balance cannot be driven below zero by a direct write", async () => {
      // The application checks first and says something useful; this is what makes it a rule. Two
      // receptionists applying the same credit at once is the case a read-then-write loses silently.
      const raw = withTenant(clinic.tenantId, actorFor(clinic.userId), (tx) =>
        tx.patientCredit.create({
          data: injected({
            id: randomUUID(),
            patientId: clinic.patientId,
            movement: "REFUNDED",
            amountMinor: 10_000_000,
            reason: "a refund larger than the balance",
            actorUserId: clinic.userId,
          }),
        }),
      );
      await expect(raw).rejects.toThrow(/negative credit balance/i);
    });

    test("a credit must say which payment it came from", async () => {
      const raw = withTenant(clinic.tenantId, actorFor(clinic.userId), (tx) =>
        tx.patientCredit.create({
          data: injected({
            id: randomUUID(),
            patientId: clinic.patientId,
            movement: "CREDIT",
            amountMinor: 100,
            actorUserId: clinic.userId,
          }),
        }),
      );
      await expect(raw).rejects.toThrow(/patient_credits_credit_has_source/i);
    });

    test("a refund must carry a reason, whatever the caller is", async () => {
      const raw = withTenant(clinic.tenantId, actorFor(clinic.userId), (tx) =>
        tx.patientCredit.create({
          data: injected({
            id: randomUUID(),
            patientId: clinic.patientId,
            movement: "REFUNDED",
            amountMinor: 100,
            actorUserId: clinic.userId,
          }),
        }),
      );
      await expect(raw).rejects.toThrow(/patient_credits_refund_has_reason/i);
    });
  });
});
