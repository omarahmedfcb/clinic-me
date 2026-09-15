// Completion turns a visit's procedures into a charge — Phase 5 PR 4, `PHASE-5-PLAN.md` §2 as ruled.
// The line's name and price are frozen here; nothing downstream re-joins them to `services`.

import { randomUUID } from "node:crypto";
import { injected } from "../../prisma/injected.ts";
import type { TransactionClient } from "../../prisma/with-tenant.ts";
import { visitScope, type VisitScopeCaller } from "../clinical/visit-scope.ts";
import { creditFromPayment, CREDIT_ORIGIN } from "./patient-credit.ts";

/**
 * Writes the charge for a visit that has just completed.
 *
 * **Snapshot, not join** — the ruling that closed `PHASE-5-PLAN.md` §2. `visit_procedures` stays
 * the doctor's record of what was done, and each row is copied into `visit_charge_lines` with its
 * name and unit price as they are at this instant. The moment an admin edits a service price, every
 * historical charge would otherwise move, and unrecoverably so: the old price was never written
 * anywhere. `appointments.quoted_price_minor` exists for the same reason.
 *
 * **A missing price is a zero line, not a refusal.** `visit_procedures.unit_price_minor` is
 * nullable, and a procedure recorded without one is a real thing — the doctor did it and the price
 * comes later. The line is written at zero so the invoice proceeds and settles.
 *
 * **The doctor's adjustment becomes its own signed line** (R1), never an edit to a snapshotted one.
 *
 * Idempotent: a visit that already has a charge is left alone. Completion is compare-and-set and
 * cannot run twice for one visit, but a retry that produced a second charge would be a duplicate
 * bill, which is worth being certain about rather than reasoning about.
 */
export async function writeChargeForVisit(
  tx: TransactionClient,
  visitId: string,
  patientId: string,
  appointmentId: string,
  caller: VisitScopeCaller,
): Promise<string | null> {
  const existing = await tx.visitCharge.findFirst({ where: { visitId }, select: { id: true } });
  if (existing !== null) return existing.id;

  const procedures = await tx.visitProcedure.findMany({
    where: { visitId },
    select: { quantity: true, unitPriceMinor: true, serviceId: true, source: true },
    orderBy: { createdAt: "asc" },
  });

  // **The catalogue is read at its root, not through the `service` relation**, and the distinction
  // is the one `price-snapshot-is-never-rejoined.spec.ts` enforces: a query rooted at a visit
  // asking "what did this cost" re-prices history, while a query rooted at `services` asking "what
  // does this cost today", in order to copy it onto a new row, is the sanctioned reader. This is
  // the second kind, and writing it the first way failed that guard.
  const catalogue = new Map(
    (
      await tx.service.findMany({
        where: { id: { in: [...new Set(procedures.map((procedure) => procedure.serviceId))] } },
        select: { id: true, nameAr: true, priceMinor: true },
      })
    ).map((service) => [service.id, service]),
  );

  const lines = procedures.map((procedure) => {
    const service = catalogue.get(procedure.serviceId);
    // The procedure's own price wins when it has one: reception or the doctor recorded it against
    // this visit, and the catalogue may have moved since. The catalogue is the fallback.
    const unitPrice = procedure.unitPriceMinor ?? service?.priceMinor ?? null;
    return {
      // The Arabic name, because it is what the clinic calls the service. The English receipt is a
      // separate concern and reads `services.name_en` when PR 9 builds it.
      nameSnapshot: service?.nameAr ?? "",
      unitPriceMinor: unitPrice ?? 0,
      quantity: procedure.quantity,
      serviceId: procedure.serviceId,
    };
  });

  // R1: recorded on the visit before completion, because completion is what creates the charge.
  const visit = await tx.visit.findFirst({
    where: { id: visitId, ...visitScope(caller) },
    select: { priceAdjustmentMinor: true, priceAdjustedByUserId: true },
  });

  const subtotal =
    lines.reduce((total, line) => total + line.unitPriceMinor * line.quantity, 0) +
    (visit?.priceAdjustmentMinor ?? 0);

  const chargeId = randomUUID();
  await tx.visitCharge.create({
    data: injected({ id: chargeId, visitId, patientId, subtotalMinor: subtotal }),
  });

  // `createMany` rather than a loop: one statement, and the lines of one charge are written
  // together or not at all -- a half-written charge would bill for part of a visit.
  await tx.visitChargeLine.createMany({
    data: lines.map((line) =>
      injected({
        id: randomUUID(),
        chargeId,
        nameSnapshot: line.nameSnapshot,
        unitPriceMinor: line.unitPriceMinor,
        quantity: line.quantity,
        source: "CATALOGUE" as const,
        serviceId: line.serviceId,
      }),
    ),
  });

  if (visit?.priceAdjustmentMinor != null && visit.priceAdjustedByUserId !== null) {
    await tx.visitChargeLine.create({
      data: injected({
        id: randomUUID(),
        chargeId,
        // Arabic, like every other line: this is what the clinic reads on its own screen. The
        // English receipt reads its own labels.
        nameSnapshot: "تعديل الطبيب",
        unitPriceMinor: visit.priceAdjustmentMinor,
        quantity: 1,
        source: "ADJUSTMENT" as const,
        adjustedByUserId: visit.priceAdjustedByUserId,
      }),
    });
  }

  // **Q19: money can arrive before the invoice exists.** A pre-payment taken at check-in has no
  // charge to point at, so it is written with `charge_id` NULL and waits. When the visit completes
  // and this charge appears, those payments attach to it and the balance moves by itself -- the
  // view is a sum across payment rows, so nothing recalculates anything.
  //
  // Matched on the appointment rather than the patient: a patient who pre-paid for Tuesday and
  // walks in on Thursday has not paid for Thursday, and quietly settling Thursday's charge with
  // Tuesday's money would be this system deciding something nobody asked it to decide.
  // The appointment is passed in rather than read back off the visit: every reader of `visits`
  // goes through the shared scope filter (the draft-privacy guard enforces it), and the caller
  // completing the visit already holds the id.
  await tx.payment.updateMany({
    where: { appointmentId, chargeId: null },
    data: { chargeId, visitId },
  });

  /**
   * **A pre-payment larger than the bill becomes credit, rather than a negative balance.**
   *
   * The first of the three origins R-A leaves standing, and the one refusal cannot reach: money
   * taken at check-in has no charge to be refused against, and by the time the bill exists it has
   * already been paid. Somebody who pre-paid 100 for a visit that turned out to cost 60 attached
   * all 100 here, and the charge's balance went to −40 — an amount no screen has a sentence for.
   *
   * The 40 is the patient's, so it is credited rather than left as a negative number on the bill.
   *
   * The balance is read from the view rather than recomputed, so this and the desk cannot disagree
   * about what was owed. It is negative only when the attached payments exceeded the share.
   */
  const balances = await tx.$queryRaw<{ balance_minor: number }[]>`
    SELECT balance_minor FROM visit_charge_balances WHERE charge_id = ${chargeId}::uuid`;
  const balance = balances[0]?.balance_minor ?? 0;

  if (balance < 0) {
    // Attributed to the latest receipt attached here — the one whose money went past the bill.
    // With a single pre-payment, which is the ordinary case, there is nothing to choose between.
    const latest = await tx.payment.findFirst({
      where: { chargeId, appointmentId },
      orderBy: { receiptNumber: "desc" },
      select: { id: true },
    });
    if (latest !== null) {
      await creditFromPayment(tx, {
        patientId,
        paymentId: latest.id,
        amountMinor: -balance,
        actorUserId: caller.actor.userId,
        reason: CREDIT_ORIGIN.prePaymentAboveBill,
      });
    }
  }

  return chargeId;
}
