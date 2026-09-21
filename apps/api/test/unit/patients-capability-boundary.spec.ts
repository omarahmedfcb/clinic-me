import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { permissionLevel, type Capability } from "../../src/common/permissions.ts";
import type { MembershipRole } from "../../src/generated/prisma/enums.ts";

/**
 * Pins the read/write boundary on patient routes, and the roles that hold each side.
 *
 * `patients.read` was split out of `patients.write` on 2026-09-06 so that reading a patient is not
 * decided by a capability named for writing. Nothing asserted the result, and the comment in
 * `permissions.ts` describing the *old* shape outlived the change — long enough to be read as
 * current on 2026-09-18 and nearly produce a second split of something already split.
 *
 * So the boundary is assertions rather than prose. A future change to either half is then a
 * deliberate edit here, in front of a reviewer, which is the point.
 */
function patientReadRoutes(): { route: string; capability: string }[] {
  const controller = path.resolve(__dirname, "..", "..", "src", "modules", "patients", "patients.controller.ts");
  const text = readFileSync(controller, "utf8");
  const found: { route: string; capability: string }[] = [];
  const pattern = /@Get\(([^)]*)\)\s*(?:\/\*[\s\S]*?\*\/\s*)?(?:\/\/[^\n]*\n\s*)*@RequirePermission\(\s*"([^"]+)"/g;
  for (const match of text.matchAll(pattern)) {
    found.push({ route: (match[1] ?? "").replace(/["']/g, "").trim() || "/", capability: match[2] ?? "" });
  }
  return found;
}

describe("the patient read/write boundary", () => {
  test("every GET on the patients controller is gated by a read capability, never by a write one", () => {
    const routes = patientReadRoutes();
    // The file has GETs; an empty list would pass this vacuously and prove nothing.
    expect(routes.length).toBeGreaterThan(5);
    expect(routes.filter((route) => /\.write$/.test(route.capability))).toEqual([]);
  });

  test("search is a read, and it is `patients.read`", () => {
    expect(patientReadRoutes().find((route) => route.route === "/")?.capability).toBe("patients.read");
  });

  /**
   * One GET elsewhere is deliberately `patients.write`, and it is named here rather than excluded by
   * a pattern: `insurance-companies/selectable` is the list reception picks from *while attaching a
   * policy*, so it belongs to the writing act, not to reading a patient. Recorded so the exception
   * stays visible; if a second one appears, this test is where the argument for it gets made.
   */
  test("the one documented exception is still the only one", () => {
    const root = path.resolve(__dirname, "..", "..", "src", "modules");
    const walk = (directory: string): string[] =>
      readdirSync(directory).flatMap((entry) => {
        const full = path.join(directory, entry);
        if (statSync(full).isDirectory()) return walk(full);
        return full.endsWith(".controller.ts") ? [full] : [];
      });

    const exceptions: string[] = [];
    for (const file of walk(root)) {
      const text = readFileSync(file, "utf8");
      for (const match of text.matchAll(/@Get\(([^)]*)\)\s*@RequirePermission\(\s*"(patients\.write)"/g)) {
        exceptions.push((match[1] ?? "").replace(/["']/g, "").trim());
      }
    }
    expect(exceptions).toEqual(["insurance-companies/selectable"]);
  });

  /**
   * The column as it stands. The instruction that produced this file was "assert the matrix diff is
   * only the split", and a table nobody wrote down cannot be diffed.
   */
  const ROLES: MembershipRole[] = ["OWNER", "ADMIN", "DOCTOR", "RECEPTIONIST", "AI_AGENT"];
  test.each([
    ["patients.read", ["full", "full", "full", "full", "none"]],
    ["patients.write", ["none", "full", "full", "full", "none"]],
    ["patients.browse", ["full", "full", "none", "full", "none"]],
    ["patients.merge", ["full", "full", "none", "none", "none"]],
  ])("%s grants exactly what it grants today", (capability, expected) => {
    expect(ROLES.map((role) => permissionLevel(role, capability as Capability))).toEqual(expected);
  });
});
