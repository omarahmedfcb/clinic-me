/**
 * The test-database drift guard.
 *
 * `prisma migrate deploy` only moves forward. A database that has applied a migration the checked-out
 * branch does not carry cannot be repaired by running it again, and the suite then fails somewhere
 * unrelated — on 2026-09-16, twelve `staff-accounts` specs died on a null constraint for
 * `tenants.country`, a column only #113 adds, after the test database was left on that branch.
 */

import { compareMigrations, driftMessage } from "../migration-drift.ts";

const DEVELOP = [
  "20260912090000_user_profile_photo",
  "20260913080000_membership_role_guards",
  "20260913090000_audit_users",
];

// The two #113 adds. These are the exact names that caused the incident.
const PLATFORM = ["20260914120000_platform_console", "20260915120000_platform_back_office"];

describe("test-database migration drift", () => {
  test("a database matching the branch has no drift", () => {
    expect(compareMigrations(DEVELOP, DEVELOP)).toEqual({ ahead: [], pending: [] });
  });

  test("migrations in the tree and not yet applied are pending, not drift", () => {
    // The normal case `migrate deploy` exists for, and it must not fail the suite.
    const report = compareMigrations(DEVELOP.slice(0, 1), DEVELOP);
    expect(report.ahead).toEqual([]);
    expect(report.pending).toEqual(DEVELOP.slice(1).sort());
  });

  test("migrations applied that the branch does not carry are drift — the 2026-09-16 case", () => {
    const report = compareMigrations([...DEVELOP, ...PLATFORM], DEVELOP);
    expect(report.ahead).toEqual(PLATFORM.sort());
    expect(report.pending).toEqual([]);
  });

  test("both directions at once are reported separately", () => {
    const report = compareMigrations([...DEVELOP.slice(0, 2), ...PLATFORM], DEVELOP);
    expect(report.ahead).toEqual(PLATFORM.sort());
    expect(report.pending).toEqual([DEVELOP[2]]);
  });

  test("an empty database is not drift", () => {
    expect(compareMigrations([], DEVELOP).ahead).toEqual([]);
  });

  describe("the message", () => {
    test("names the database, the migrations, and the command that fixes it", () => {
      const message = driftMessage("clinic_os_test", PLATFORM);
      expect(message).toContain("clinic_os_test");
      expect(message).toContain("20260914120000_platform_console");
      expect(message).toContain("DROP DATABASE IF EXISTS clinic_os_test");
      // The reason it cannot simply be re-run, because that is the part a reader will otherwise try.
      expect(message).toContain("only moves forward");
    });
  });
});
