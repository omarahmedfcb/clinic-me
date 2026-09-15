import { uuidv7 } from "uuidv7";
import { prisma } from "../../src/prisma/client.ts";
import { injected } from "../../src/prisma/injected.ts";
import { withTenant } from "../../src/prisma/with-tenant.ts";
import { actorFor, seedClinic, teardownClinic, type ClinicFixture } from "./fixtures.ts";

/**
 * The patient file number — Phase 5 PR 2.
 *
 * **The test that matters is the concurrent one.** A file number produced by reading
 * `max(file_number)` and adding one is correct in every single-threaded test ever written, and
 * hands two patients the same number the first time two receptionists register at once — because
 * both read the same maximum before either writes. Nothing else in this file would notice.
 *
 * The allocation is a BEFORE INSERT trigger rather than application code: eighteen places in this
 * repository insert a patient, and an allocation living in one of them is one the other seventeen
 * skip.
 */

const newPatient = (n: number) => ({
  id: uuidv7(),
  fullNameAr: `مريض ${n}`,
  phoneE164: `+2010999${String(n).padStart(4, "0")}`,
  relationshipToContact: "SELF" as const,
  status: "ACTIVE" as const,
});

describe("the patient file number", () => {
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

  test("every seeded patient already has one, and they start at 1", async () => {
    // The backfill, asserted rather than assumed: a nullable column would put "no file number" on
    // a printed sheet for every patient registered before this migration.
    await withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) => {
      const lowest = await tx.patient.findFirstOrThrow({
        orderBy: { fileNumber: "asc" },
        select: { fileNumber: true },
      });
      expect(lowest.fileNumber).toBe(1);
    });
  });

  test("an insert that names no number is given the next one", async () => {
    await withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) => {
      const before = await tx.tenant.findUniqueOrThrow({
        where: { id: clinic.tenantId },
        select: { nextPatientFileNumber: true },
      });
      const created = await tx.patient.create({
        data: injected(newPatient(1)),
        select: { fileNumber: true },
      });
      expect(created.fileNumber).toBe(before.nextPatientFileNumber);

      const after = await tx.tenant.findUniqueOrThrow({
        where: { id: clinic.tenantId },
        select: { nextPatientFileNumber: true },
      });
      expect(after.nextPatientFileNumber).toBe(before.nextPatientFileNumber + 1);
    });
  });

  test("two clinics number their patients independently", async () => {
    // A single database sequence would make the second clinic's first patient number 4,001 — not
    // what a receptionist reads down a phone, and it leaks how many patients other clinics have.
    const here = await withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) =>
      tx.patient.findFirstOrThrow({ orderBy: { fileNumber: "asc" }, select: { fileNumber: true } }),
    );
    const there = await withTenant(other.tenantId, actorFor(other.userId), async (tx) =>
      tx.patient.findFirstOrThrow({ orderBy: { fileNumber: "asc" }, select: { fileNumber: true } }),
    );

    // The sharp assertion: **both clinics hold the same number**, which one shared counter could
    // not produce. Comparing magnitudes instead would pass on a single sequence that happened to
    // hand out ascending values.
    expect({ here: here.fileNumber, there: there.fileNumber }).toEqual({ here: 1, there: 1 });
  });

  test("registrations whose transactions overlap produce distinct numbers", async () => {
    /**
     * **The guard, and it needs the barrier to be one.**
     *
     * The first version of this test fired five `withTenant` calls with `Promise.all` and asserted
     * distinct numbers. It passed with the allocation replaced by `max(file_number) + 1` — the
     * transactions simply did not overlap, so each one saw the previous one's committed row. A
     * guard that passes against the implementation it exists to reject is worse than no guard.
     *
     * So every transaction is opened and held at the gate until all five are open. Only then do
     * they insert. `max + 1` now reads the same committed maximum in all five and computes the same
     * number; the unique index rejects four of them, and this test goes red.
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
          return tx.patient.create({
            data: injected(newPatient(100 + index)),
            select: { fileNumber: true },
          });
        }),
      ),
    );

    const numbers = results.map((row) => row.fileNumber);
    expect(new Set(numbers).size).toBe(CONCURRENCY);
    // Contiguous as well as distinct: allocations from one counter leave no holes.
    const sorted = [...numbers].sort((a, b) => a - b);
    expect(sorted[CONCURRENCY - 1]! - sorted[0]!).toBe(CONCURRENCY - 1);
  });

  test("the same number twice in one clinic is refused by the database", async () => {
    // The index is the backstop. The trigger makes a collision not happen; this makes it
    // impossible, which is the distinction the project keeps insisting on.
    const taken = await withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) =>
      tx.patient.findFirstOrThrow({ orderBy: { fileNumber: "desc" }, select: { fileNumber: true } }),
    );

    await expect(
      withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) =>
        tx.patient.create({
          data: injected({ ...newPatient(200), fileNumber: taken.fileNumber }),
          select: { id: true },
        }),
      ),
    ).rejects.toThrow();
  });

  test("a number supplied explicitly is kept, so a migration can renumber", async () => {
    // The trigger only fills a NULL. Without that, a data migration correcting numbers would have
    // every row silently renumbered underneath it.
    const created = await withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) =>
      tx.patient.create({
        data: injected({ ...newPatient(300), fileNumber: 9_000 }),
        select: { fileNumber: true },
      }),
    );
    expect(created.fileNumber).toBe(9_000);
  });
});
