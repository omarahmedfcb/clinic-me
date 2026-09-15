import { hasLapsed, isFuture, isInForce, standingOf } from "./policy-window.ts";

/**
 * The window comparison, which is the whole of "is this patient covered today".
 *
 * Worth testing hard for one reason: there is no `is_active` column, so this function is the only
 * thing standing between a lapsed policy and reception being told the patient is covered. There is
 * no second source to disagree with it and catch a mistake.
 */
describe("policy window", () => {
  const openEnded = { validFrom: "2026-01-01", validTo: null };
  const bounded = { validFrom: "2026-01-01", validTo: "2026-12-31" };

  describe("both bounds are inclusive", () => {
    test("the first day is covered", () => {
      expect(isInForce(bounded, "2026-01-01")).toBe(true);
    });

    test("the last day is covered", () => {
      // The one that would be silently wrong with an exclusive end: it shows up as a single patient
      // turned away on the last day of their cover, not as a failing test.
      expect(isInForce(bounded, "2026-12-31")).toBe(true);
    });

    test("the day before it starts is not", () => {
      expect(isInForce(bounded, "2025-12-31")).toBe(false);
    });

    test("the day after it ends is not", () => {
      expect(isInForce(bounded, "2027-01-01")).toBe(false);
    });
  });

  describe("an open-ended policy", () => {
    test("is in force long after it started", () => {
      expect(isInForce(openEnded, "2099-06-15")).toBe(true);
    });

    test("is still not in force before it started", () => {
      // NULL validTo must not read as "always valid" -- it means no stated end, not no start.
      expect(isInForce(openEnded, "2025-12-31")).toBe(false);
    });

    test("never lapses", () => {
      expect(hasLapsed(openEnded, "2099-06-15")).toBe(false);
    });
  });

  describe("lapsed is not merely not-in-force", () => {
    // The distinction the founder's ruling depends on: expired cover is shown as history, and a
    // policy that has not started yet is not history -- it is a reason to book next week.
    const future = { validFrom: "2027-01-01", validTo: "2027-12-31" };

    test("a policy that has not started is FUTURE, not LAPSED", () => {
      expect(isInForce(future, "2026-06-01")).toBe(false);
      expect(hasLapsed(future, "2026-06-01")).toBe(false);
      expect(isFuture(future, "2026-06-01")).toBe(true);
      expect(standingOf(future, "2026-06-01")).toBe("FUTURE");
    });

    test("a policy that has ended is LAPSED", () => {
      expect(standingOf(bounded, "2027-03-01")).toBe("LAPSED");
      expect(hasLapsed(bounded, "2027-03-01")).toBe(true);
    });

    test("a policy in its window is ACTIVE", () => {
      expect(standingOf(bounded, "2026-06-01")).toBe("ACTIVE");
    });
  });

  describe("string comparison is chronological, including across boundaries", () => {
    // Guards the one assumption the implementation makes: zero-padded fixed-width YYYY-MM-DD sorts
    // chronologically. A single unpadded month would break it silently and only for some dates.
    test("a September date is not sorted after an October one", () => {
      const sep = { validFrom: "2026-09-01", validTo: "2026-09-30" };
      expect(isInForce(sep, "2026-10-01")).toBe(false);
      expect(isInForce(sep, "2026-09-09")).toBe(true);
    });

    test("year boundaries compare correctly", () => {
      const crossing = { validFrom: "2026-12-15", validTo: "2027-01-15" };
      expect(isInForce(crossing, "2026-12-31")).toBe(true);
      expect(isInForce(crossing, "2027-01-01")).toBe(true);
      expect(isInForce(crossing, "2027-01-16")).toBe(false);
    });
  });

  describe("standingOf is total", () => {
    test("every policy is exactly one of the three on any day", () => {
      const policies = [openEnded, bounded, { validFrom: "2027-01-01", validTo: null }];
      const days = ["2025-01-01", "2026-06-01", "2027-06-01", "2099-01-01"];

      for (const policy of policies) {
        for (const day of days) {
          const flags = [isFuture(policy, day), isInForce(policy, day), hasLapsed(policy, day)];
          // Exactly one must be true. Two would mean the screen could show a policy as both
          // covered and expired; none would mean it shows nothing at all.
          expect(flags.filter(Boolean)).toHaveLength(1);
          expect(["FUTURE", "ACTIVE", "LAPSED"]).toContain(standingOf(policy, day));
        }
      }
    });
  });
});
