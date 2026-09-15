import { OWN_ENFORCEMENT, ownCapabilities } from "./own-capability-enforcement.ts";

/**
 * Every `own` capability is classified, and the classification is honest.
 *
 * This is the guard for the failure `PHASE-3.md` Q20 and Q22 name: **a label stood in for a check.**
 * `DOCTOR: OWN` in the permission matrix reads as "the scoping is handled" and guarantees nothing,
 * because `PermissionGuard` structurally cannot enforce `own` — enforcement lives in a service,
 * elsewhere, invisible from the matrix.
 *
 * Two capabilities are currently `own` and enforced by nothing, because their endpoints do not
 * exist. Writing one of those endpoints now means changing `OWN_ENFORCEMENT`, and that is the whole
 * mechanism: the moment someone builds the reports screen, this file makes them state whether they
 * scoped it, rather than inheriting an `own` somebody else wrote three phases earlier.
 */
describe("own-level capabilities are accounted for", () => {
  test("every own capability is classified", () => {
    // Derived from the matrix, so a capability that GAINS an `own` level fails here rather than
    // slipping in unclassified -- the direction a hand-maintained list always misses.
    for (const capability of ownCapabilities()) {
      expect(OWN_ENFORCEMENT[capability]).toBeDefined();
    }
  });

  test("nothing is classified that is not actually own", () => {
    // The other direction. A capability demoted from `own` to `full` or `none` must not leave a
    // stale "enforced" claim behind, which would read as a guarantee about a rule that no longer
    // exists.
    const own = new Set<string>(ownCapabilities());
    for (const capability of Object.keys(OWN_ENFORCEMENT)) {
      expect(own.has(capability)).toBe(true);
    }
  });

  test("the two known-unenforced capabilities are still unenforced, and say why", () => {
    // Not a list to keep green by editing: these are `own` in ARCHITECTURE.md §8 and no endpoint
    // consumes them. When one gains an endpoint, this assertion should be changed *at the same
    // time as the scoping is written*, and that pairing is the point.
    for (const capability of ["appointments.overrideSlotConflict", "reports.financial"]) {
      const entry = OWN_ENFORCEMENT[capability];
      expect(entry?.status).toBe("no-endpoint-yet");
      expect(entry?.status === "no-endpoint-yet" ? entry.owed.length : 0).toBeGreaterThan(80);
    }
  });

  test("doctorSchedules.manage names where it is enforced and what proves it", () => {
    const entry = OWN_ENFORCEMENT["doctorSchedules.manage"];
    expect(entry?.status).toBe("enforced");
    if (entry?.status === "enforced") {
      expect(entry.where).toContain("schedules.service.ts");
      expect(entry.provenBy).toContain("schedules-own-scope");
    }
  });
});
