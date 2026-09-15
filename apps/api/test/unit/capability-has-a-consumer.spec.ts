import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { CAPABILITIES } from "../../src/common/permissions.ts";
import { NO_CONSUMER } from "../../src/common/own-capability-enforcement.ts";

/**
 * Every capability is either consumed by a route, or registered as not-yet-built with what is owed.
 *
 * ## The failure this exists to prevent
 *
 * A capability sitting in the matrix with no endpoint is a **statement about a rule that nothing
 * enforces**, and the next author inherits it as settled. `PHASE-3.md` Q22 and Q23 name the shape:
 * a label stood in for a check.
 *
 * The sharpest case is `visits.write`, which is `DOCTOR: FULL`. When somebody writes `POST /visits`,
 * `PermissionGuard` will admit any doctor, and `FULL` in the matrix reads as *"no scoping needed"* —
 * a stronger and more misleading signal than `own`, which at least reads as *"scoping owed"*. The
 * thing it would permit is a doctor authoring a visit and a prescription on a colleague's patient,
 * with an audit trail naming them correctly and a record that looks entirely legitimate. A bad read
 * leaves a trace to investigate; that leaves a diagnosis another doctor will act on.
 *
 * ## Why this test and not an ownership check on the visit endpoint
 *
 * Because there is no visit endpoint. Writing the check now would be a guard that cannot be proven
 * by breaking it, which is precisely what Q22 forbids — you prove the hole is reachable before you
 * build the wall. This is the guard that can be proven today: it fails the moment a capability is
 * added without a consumer, and it fails the moment a registered "not built yet" capability gains a
 * route while its entry still says nothing is owed.
 */

const API_ROOT = path.resolve(__dirname, "..", "..");

function sourceFiles(directory: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(directory)) {
    if (entry === "node_modules" || entry === "generated" || entry === "dist") continue;
    const full = path.join(directory, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (full.endsWith(".ts")) out.push(full);
  }
  return out;
}

/** Capabilities named by a `@RequirePermission("...")` on any route in `src`. */
function consumedCapabilities(): Set<string> {
  const found = new Set<string>();
  for (const file of sourceFiles(path.join(API_ROOT, "src"))) {
    if (file.endsWith(".spec.ts")) continue;
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(/@RequirePermission\(\s*"([^"]+)"/g)) {
      const capability = match[1];
      if (capability !== undefined) found.add(capability);
    }
  }
  return found;
}

describe("every capability has a consumer, or an admission that it has none", () => {
  const consumed = consumedCapabilities();

  test("the scan actually reads this codebase, so an empty result cannot pass", () => {
    // Without this the assertions below are vacuous against a broken path -- and a security
    // conformance test that passes because it found nothing is the worst of both worlds.
    expect(consumed.size).toBeGreaterThan(4);
    expect(consumed.has("appointments.write")).toBe(true);
  });

  test("no capability is both unconsumed and unregistered", () => {
    const unaccounted = CAPABILITIES.filter(
      (capability) => !consumed.has(capability) && NO_CONSUMER[capability] === undefined,
    );
    expect(unaccounted).toEqual([]);
  });

  test("nothing claims to be unbuilt while a route is using it", () => {
    // The other direction, and the one that rots. When the visit-write endpoint lands, its entry
    // here must be deleted in the same change -- which is the moment the ownership check it
    // describes has to be written.
    const stale = Object.keys(NO_CONSUMER).filter((capability) => consumed.has(capability));
    expect(stale).toEqual([]);
  });

  test("every unbuilt entry says what is owed, not merely that it is absent", () => {
    for (const [capability, owed] of Object.entries(NO_CONSUMER)) {
      expect(owed.length).toBeGreaterThan(40);
      expect(capability).toBeDefined();
    }
  });

  /**
   * `prescriptions.write` was the entry this file was written around, and PR 7e is when it fired.
   *
   * Its registry entry said the ownership question is answered where the clinical record attaches to
   * a patient, and told the next author to reuse the existing relationship rule rather than invent a
   * second one. The prescription and investigation routes do: `visit-orders.ts` resolves access
   * through `resolveAccess` — which carries the transfer grant — and then asks
   * `isPresentWithDoctor` patient-first, because the appointment in the path may be finished (D32).
   * The entry is removed in the same change that asserts the check, which is what it was there for.
   */
  test("prescriptions.write is consumed, and its ownership check exists", () => {
    expect(consumed.has("prescriptions.write")).toBe(true);
    expect(NO_CONSUMER["prescriptions.write"]).toBeUndefined();

    const orders = readFileSync(
      path.join(API_ROOT, "src", "modules", "clinical", "visit-orders.ts"),
      "utf8",
    );
    // Not a spelling check: a route consuming this capability admits any doctor in the clinic, so
    // without the relationship check one of them could write a prescription onto any patient.
    expect(orders).toContain("resolveAccess");
    expect(orders).toContain("isPresentWithDoctor");
  });

  /**
   * `visits.write` used to sit alongside it, and this is what happened when the guard fired.
   *
   * The attachments upload route consumed the capability on 2026-09-05 and this file went red. The
   * first draft of that route checked the caller was a doctor and the patient existed, and nothing
   * else — so any doctor in the clinic could have filed a document onto any patient's record. The
   * registry entry is what made that visible; the check written in response is asserted here so the
   * capability cannot quietly go back to being unenforced.
   */
  test("visits.write is consumed, and its ownership check exists", () => {
    expect(consumed.has("visits.write")).toBe(true);
    expect(NO_CONSUMER["visits.write"]).toBeUndefined();

    const service = readFileSync(
      path.join(API_ROOT, "src", "modules", "attachments", "attachments.service.ts"),
      "utf8",
    );
    // Not a spelling check: every route consuming visits.write must run the relationship check, and
    // the upload path is the one that would be silently unscoped without it.
    expect(service).toContain("hasCareRelationship");
    expect(service.match(/await hasCareRelationship\(/g)?.length ?? 0).toBeGreaterThanOrEqual(4);
  });
});
