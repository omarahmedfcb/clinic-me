import { constraintOccupies, engineOccupies } from "../../src/modules/appointments/domain/occupancy.ts";
import type { OccupancyRow } from "../../src/modules/appointments/domain/types.ts";
import { prisma } from "../../src/prisma/client.ts";

/**
 * `constraintOccupies()` against the **live** `no_double_booking` predicate — PHASE-2.md Q15.
 *
 * Two definitions of "occupied" that drift are silent in both directions: the engine offers slots
 * Postgres will reject (a patient is told a time is free, then the booking 409s), or it hides
 * slots Postgres would accept (a doctor's day looks fuller than it is, and nobody ever notices,
 * because nothing anywhere reports a slot that was never shown).
 *
 * ## Why this executes the predicate rather than reading it
 *
 * The obvious version of this test greps `pg_get_constraintdef()` for `'CANCELLED'` and
 * `'NO_SHOW'`. That passes against a predicate with the comparison inverted, an extra `OR`, or a
 * third status added — it only proves those two strings are present somewhere.
 *
 * So the predicate is **extracted from the constraint and run by Postgres** over every
 * combination of status and `allow_overlap`, and each answer is compared with the TypeScript
 * function. Postgres evaluates its own rule; TypeScript evaluates ours; the test compares the two
 * truth tables. A change to either side that the other does not match fails here.
 *
 * `AppointmentStatus` is read from `pg_enum` rather than hardcoded, so adding a status to the
 * schema without deciding whether it occupies time also fails here.
 */
describe("engine occupancy matches the database constraint", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  /** The `WHERE (...)` tail of the EXCLUDE constraint — the part that decides what is enforced. */
  async function constraintPredicate(): Promise<string> {
    const rows = await prisma.$queryRaw<{ def: string }[]>`
      SELECT pg_get_constraintdef(c.oid) AS def
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      WHERE t.relname = 'appointments' AND c.conname = 'no_double_booking'
    `;
    expect(rows).toHaveLength(1);
    const def = rows[0]!.def;

    const marker = " WHERE (";
    const at = def.indexOf(marker);
    // A constraint with no predicate would exclude every row, cancelled ones included — a very
    // different rule that must not be mistaken for "no drift".
    expect(at).toBeGreaterThan(-1);
    return def.slice(at + marker.length, def.length - 1);
  }

  async function statuses(): Promise<string[]> {
    const rows = await prisma.$queryRaw<{ label: string }[]>`
      SELECT e.enumlabel AS label
      FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
      WHERE t.typname = 'AppointmentStatus'
      ORDER BY e.enumsortorder
    `;
    return rows.map((r) => r.label);
  }

  const asRow = (status: string, allowOverlap: boolean): OccupancyRow => ({
    id: "row",
    doctorId: "doctor",
    scheduledStart: new Date("2026-09-01T09:00:00Z"),
    scheduledEnd: new Date("2026-09-01T09:30:00Z"),
    status,
    allowOverlap,
    serviceBufferMinutes: 0,
  });

  test("the two truth tables are identical, cell for cell", async () => {
    const predicate = await constraintPredicate();
    const allStatuses = await statuses();
    expect(allStatuses.length).toBeGreaterThan(1);

    // Postgres evaluates ITS predicate over every combination. The cast makes the enum comparison
    // in the predicate resolve exactly as it does on the real table.
    const values = allStatuses
      .flatMap((s) => [true, false].map((o) => `('${s}'::"AppointmentStatus", ${o})`))
      .join(", ");

    const dbRows = await prisma.$queryRawUnsafe<
      { status: string; allow_overlap: boolean; blocked: boolean }[]
    >(
      `SELECT v.status::text AS status, v.allow_overlap, (${predicate}) AS blocked
       FROM (VALUES ${values}) AS v(status, allow_overlap)`,
    );

    expect(dbRows).toHaveLength(allStatuses.length * 2);

    const disagreements = dbRows
      .map((row) => ({
        status: row.status,
        allowOverlap: row.allow_overlap,
        database: row.blocked,
        engine: constraintOccupies(asRow(row.status, row.allow_overlap)),
      }))
      .filter((cell) => cell.database !== cell.engine);

    expect(disagreements).toEqual([]);
  });

  /**
   * `engineOccupies` deliberately differs from the constraint, on exactly one case. Asserting the
   * difference — rather than only asserting the agreement above — is what stops someone
   * "simplifying" the two predicates into one and quietly re-offering overridden time to the
   * WhatsApp agent (PHASE-2.md Q16).
   */
  test("engineOccupies differs from the constraint on allow_overlap, and only there", async () => {
    const allStatuses = await statuses();
    const differing: string[] = [];

    for (const status of allStatuses) {
      for (const allowOverlap of [true, false]) {
        const row = asRow(status, allowOverlap);
        if (constraintOccupies(row) !== engineOccupies(row)) {
          differing.push(`${status}/allowOverlap=${allowOverlap}`);
        }
      }
    }

    // Every status, but only when the override is set: the database ignores such a row for
    // exclusion, while the engine still treats the time as taken.
    expect(differing.sort()).toEqual(allStatuses.map((s) => `${s}/allowOverlap=true`).sort());
  });

  /**
   * The **whole** constraint, key included — not just the predicate the tests above compare.
   *
   * This exists because of a real miss. While proving those tests by breaking them, the
   * constraint was restored on the test database from a hand-written `ALTER` that dropped
   * `tenant_id WITH =` from the exclusion key. Everything above passed: the predicate was
   * untouched, and the key is not part of the predicate. But the constraint was wrong in a way
   * that matters more than any status list — without `tenant_id`, it blocks overlapping
   * appointments for the same `doctor_id` **across tenants**, so one clinic's booking can refuse
   * another clinic's. That is a cross-tenant leak expressed as an error rather than as data, and
   * the 404 convention cannot hide it because the row was never read.
   *
   * The gap was found by comparing `pg_get_constraintdef()` against the dev database by hand. A
   * comparison a human has to remember to run is not a guard, so it is pinned here.
   *
   * The two claims are worth keeping apart: the tests above prove the two predicates **agree**;
   * this one proves the constraint is **the one we designed**. Neither implies the other.
   */
  test("the exclusion key is tenant, doctor and time range — in that order", async () => {
    const rows = await prisma.$queryRaw<{ def: string }[]>`
      SELECT pg_get_constraintdef(c.oid) AS def
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      WHERE t.relname = 'appointments' AND c.conname = 'no_double_booking'
    `;
    expect(rows[0]?.def).toBe(
      'EXCLUDE USING gist (tenant_id WITH =, doctor_id WITH =, ' +
        'tstzrange(scheduled_start, scheduled_end) WITH &&) ' +
        'WHERE (((status <> ALL (ARRAY[\'CANCELLED\'::"AppointmentStatus", ' +
        '\'NO_SHOW\'::"AppointmentStatus"])) AND (allow_overlap = false)))',
    );
  });

  /**
   * The predicate is meant to be about these two statuses. Asserted separately from the truth
   * table because the table would still pass if someone changed the SQL and the TypeScript
   * together — which is exactly the drift a reviewer would want flagged rather than absorbed.
   */
  test("the constraint releases cancelled and no-show appointments, and nothing else", async () => {
    const predicate = await constraintPredicate();
    expect(predicate).toContain("CANCELLED");
    expect(predicate).toContain("NO_SHOW");
    expect(predicate).toContain("allow_overlap");

    for (const status of await statuses()) {
      const releasedByDatabase = !constraintOccupies(asRow(status, false));
      expect(releasedByDatabase).toBe(status === "CANCELLED" || status === "NO_SHOW");
    }
  });
});
