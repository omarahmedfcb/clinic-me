import { randomUUID } from "node:crypto";
import { prisma } from "../../src/prisma/client.ts";
import { injected } from "../../src/prisma/injected.ts";
import { withTenant } from "../../src/prisma/with-tenant.ts";
import { actorFor, seedClinic, teardownClinic, type ClinicFixture } from "./fixtures.ts";

/**
 * Receipt numbering — Phase 5 PR 5. Sequential, and **gapless**, per clinic.
 *
 * **Gapless is a materially stronger guarantee than unique, and it is the reason this is not a
 * Postgres `SEQUENCE`.** `nextval` is non-transactional: a rolled-back transaction consumes a
 * number and leaves a hole, which is exactly what a tax authority asks about. The counter here is
 * an ordinary column incremented inside the same transaction as the insert, so a rollback takes the
 * increment with it.
 *
 * A `SEQUENCE`-based implementation passes the uniqueness test below and fails the rollback one.
 * That contrast is the whole point of having both.
 */

const receipt = (clinic: ClinicFixture, n: number) => ({
  id: randomUUID(),
  patientId: clinic.patientId,
  amountMinor: 1_000 + n,
  method: "CASH" as const,
  status: "PAID" as const,
});

describe("receipt numbering", () => {
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

  test("a receipt is numbered and dated without being told either", async () => {
    const written = await withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) =>
      tx.payment.create({
        data: injected(receipt(clinic, 1)),
        select: { receiptNumber: true, receiptDate: true },
      }),
    );
    expect(written.receiptNumber).toBeGreaterThan(0);
    expect(written.receiptDate).toBeInstanceOf(Date);
  });

  test("each clinic numbers its own receipts", async () => {
    // Both clinics hold the same number, which one shared sequence could not produce — and how
    // many receipts another clinic has issued is not this clinic's business.
    const here = await withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) =>
      tx.payment.findFirstOrThrow({ orderBy: { receiptNumber: "asc" }, select: { receiptNumber: true } }),
    );
    const there = await withTenant(other.tenantId, actorFor(other.userId), async (tx) =>
      tx.payment.create({ data: injected(receipt(other, 1)), select: { receiptNumber: true } }),
    );
    expect({ here: here.receiptNumber, there: there.receiptNumber }).toEqual({ here: 1, there: 1 });
  });

  test("receipts whose transactions overlap never share a number", async () => {
    /**
     * The barrier is what makes this a test rather than a formality. Five `withTenant` calls fired
     * with `Promise.all` and no gate do not overlap — each sees the previous one's committed row —
     * and the naive implementation passes. That mistake was made once already, in the patient file
     * number's spec, and caught only by breaking the database it ran against.
     */
    const CONCURRENCY = 5;
    let open = 0;
    let release = (): void => {};
    const allOpen = new Promise<void>((resolve) => {
      release = resolve;
    });

    const results = await Promise.all(
      Array.from({ length: CONCURRENCY }, (_, index) =>
        withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) => {
          open += 1;
          if (open === CONCURRENCY) release();
          await allOpen;
          return tx.payment.create({
            data: injected(receipt(clinic, 100 + index)),
            select: { receiptNumber: true },
          });
        }),
      ),
    );

    const numbers = results.map((row) => row.receiptNumber);
    expect(new Set(numbers).size).toBe(CONCURRENCY);
    const sorted = [...numbers].sort((a, b) => a - b);
    expect(sorted[CONCURRENCY - 1]! - sorted[0]!).toBe(CONCURRENCY - 1);
  });

  test("a failed transaction never burns a number", async () => {
    // **The gapless half.** A `SEQUENCE` passes every test above and fails this one: `nextval` is
    // not rolled back, so the number the failed receipt took is gone for good.
    const before = await withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) =>
      tx.tenant.findUniqueOrThrow({
        where: { id: clinic.tenantId },
        select: { nextReceiptNumber: true },
      }),
    );

    await expect(
      withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) => {
        await tx.payment.create({ data: injected(receipt(clinic, 200)), select: { receiptNumber: true } });
        // Anything at all, after the number has been taken.
        throw new Error("the receipt was abandoned");
      }),
    ).rejects.toThrow("abandoned");

    const after = await withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) =>
      tx.tenant.findUniqueOrThrow({
        where: { id: clinic.tenantId },
        select: { nextReceiptNumber: true },
      }),
    );
    expect(after.nextReceiptNumber).toBe(before.nextReceiptNumber);

    // And the next receipt actually takes the number the failed one would have had.
    const next = await withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) =>
      tx.payment.create({ data: injected(receipt(clinic, 201)), select: { receiptNumber: true } }),
    );
    expect(next.receiptNumber).toBe(before.nextReceiptNumber);
  });

  test("the run of numbers in a clinic has no holes", async () => {
    const rows = await withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) =>
      tx.payment.findMany({ select: { receiptNumber: true }, orderBy: { receiptNumber: "asc" } }),
    );
    const numbers = rows.map((row) => row.receiptNumber);
    expect(numbers[0]).toBe(1);
    // Contiguity stated as one comparison, so a failure prints the two ends rather than a list.
    expect({ last: numbers.at(-1), count: numbers.length }).toEqual({
      last: numbers.length,
      count: numbers.length,
    });
  });

  test("the same number twice in one clinic is refused by the database", async () => {
    const taken = await withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) =>
      tx.payment.findFirstOrThrow({ orderBy: { receiptNumber: "desc" }, select: { receiptNumber: true } }),
    );
    await expect(
      withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) =>
        tx.payment.create({
          data: injected({ ...receipt(clinic, 300), receiptNumber: taken.receiptNumber }),
        }),
      ),
    ).rejects.toThrow();
  });
});
