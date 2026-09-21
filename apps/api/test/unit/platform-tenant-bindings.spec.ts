import { readFileSync } from "node:fs";
import path from "node:path";
import { sourceFiles, stripComments } from "../../scripts/route-capabilities.ts";

/**
 * **The platform module binds a clinic's tenant in exactly two places, and both of them write.**
 *
 * The wall around the operator is that their session binds no tenant, so RLS returns nothing from
 * every clinical and financial table (`platform-isolation.integration.spec.ts`). `withTenant` is the
 * one call that can dissolve it: bind a clinic's id and the operator has that clinic's whole record.
 *
 * Two writes genuinely need it — seating the first ADMIN of a clinic that has just been created, and
 * writing the audit row that lands in that clinic's own trail. Neither reads. A third call would not
 * fail any test, would not look wrong in review, and would quietly make the console able to read a
 * patient, so it is counted here instead.
 */

const API_ROOT = path.resolve(__dirname, "..", "..");
const PLATFORM = path.join(API_ROOT, "src", "modules", "platform");

/** File → how many `withTenant(` calls it is allowed. Anything absent is allowed none. */
const ALLOWED = new Map<string, number>([
  // Seats the first ADMIN, and re-reads the membership when resetting that admin's password — both
  // writes-or-checks about the clinic's own staff, never about its records.
  ["platform-clinics.ts", 2],
  // One audit row per operator action (0f).
  ["platform-audit.ts", 1],
]);

describe("the platform console binds a tenant only where it must", () => {
  const counts = new Map<string, number>();

  for (const file of sourceFiles(PLATFORM, [".ts"])) {
    const name = path.basename(file);
    const source = stripComments(readFileSync(file, "utf8"));
    const calls = [...source.matchAll(/\bwithTenant\s*\(/g)].length;
    if (calls > 0) counts.set(name, calls);
  }

  test("no file binds one more often than it is allowed to", () => {
    const offenders = [...counts].filter(([name, calls]) => calls > (ALLOWED.get(name) ?? 0));
    expect(offenders).toEqual([]);
  });

  test("the guard can see the calls it is guarding, so an empty pass is impossible", () => {
    // Without this, renaming the helper or moving the module would produce a green run that checked
    // nothing — the failure mode this project has found in its own tooling five times.
    const total = [...counts.values()].reduce((sum, calls) => sum + calls, 0);
    expect(total).toBeGreaterThanOrEqual(3);
  });

  test("and it is reading the platform module, not an empty directory", () => {
    expect(sourceFiles(PLATFORM, [".ts"]).length).toBeGreaterThanOrEqual(5);
  });
});
