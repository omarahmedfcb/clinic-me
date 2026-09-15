import { ABANDON_AFTER_HOURS, isAbandoned } from "../../src/modules/clinical/draft-abandonment.ts";

/**
 * Q15 — an abandoned draft is derived on read against a passed-in instant. No job, no stored status.
 *
 * Every test below moves **only the clock**, which is the property the ruling asks for: a stored
 * status needs a sweep to maintain it, and a sweep that is never written leaves every draft reading
 * as open forever. Same reasoning as D24's transfer expiry.
 */

const UPDATED = new Date("2026-09-08T09:00:00Z");
const hoursLater = (n: number): Date => new Date(UPDATED.getTime() + n * 60 * 60 * 1000);

describe("a draft nobody finished", () => {
  const draft = { status: "DRAFT" as const, updatedAt: UPDATED };

  test("is not abandoned while it is being worked on", () => {
    expect(isAbandoned(draft, UPDATED)).toBe(false);
    expect(isAbandoned(draft, hoursLater(1))).toBe(false);
  });

  test("survives a doctor finishing late and returning next morning", () => {
    // The reason the threshold is a day rather than an hour. At 23 hours this is still open.
    expect(isAbandoned(draft, hoursLater(ABANDON_AFTER_HOURS - 1))).toBe(false);
  });

  test("is abandoned once the threshold has passed", () => {
    expect(isAbandoned(draft, hoursLater(ABANDON_AFTER_HOURS + 1))).toBe(true);
    expect(isAbandoned(draft, hoursLater(72))).toBe(true);
  });

  test("the boundary itself is not yet abandoned", () => {
    // Strictly greater-than. A draft exactly at the threshold has not yet passed it, and a test
    // that did not pin this would let the comparison flip between > and >= unnoticed.
    expect(isAbandoned(draft, hoursLater(ABANDON_AFTER_HOURS))).toBe(false);
  });

  test("the threshold is a parameter, so a caller can ask about a different window", () => {
    expect(isAbandoned(draft, hoursLater(2), 1)).toBe(true);
    expect(isAbandoned(draft, hoursLater(2), 48)).toBe(false);
  });
});

describe("a finished visit", () => {
  test("is never abandoned, however old", () => {
    // Abandonment is about unfinished work. A visit completed two years ago is a record, not a
    // loose end, and calling it abandoned would put it on a list of things to chase.
    const completed = { status: "COMPLETED" as const, updatedAt: UPDATED };
    expect(isAbandoned(completed, hoursLater(24 * 365 * 2))).toBe(false);
  });
});
