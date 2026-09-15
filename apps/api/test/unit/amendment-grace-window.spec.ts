import {
  AMENDMENT_GRACE_MS,
  withinAmendmentGrace,
} from "../../src/modules/clinical/clinical.access.ts";

/**
 * Q6's grace window at its own boundaries — ruled by the founder on 2026-09-09, `SCHEMA-DECISIONS.md`
 * D35.
 *
 * Pure and clock-free on purpose. A window is only testable at its edge if the edge can be moved
 * without moving the clock, which is the standing rule for anything whose output is called
 * reproducible (`CLAUDE.md`).
 */

const COMPLETING_DOCTOR = "00000000-0000-7000-8000-00000000d0c1";
const OTHER_DOCTOR = "00000000-0000-7000-8000-00000000d0c2";
const COMPLETED_AT = new Date("2026-09-09T08:00:00.000Z");

const visit = { doctorId: COMPLETING_DOCTOR, completedAt: COMPLETED_AT };
const at = (ms: number): Date => new Date(COMPLETED_AT.getTime() + ms);

describe("Q6's amendment grace window", () => {
  it("is twenty-four hours", () => {
    // Spelled as a fact rather than left to arithmetic elsewhere: the ruling names the number.
    expect(AMENDMENT_GRACE_MS).toBe(24 * 60 * 60 * 1000);
  });

  it("opens at completion and closes at the boundary, not near it", () => {
    expect(withinAmendmentGrace(COMPLETING_DOCTOR, visit, at(0))).toBe(true);
    expect(withinAmendmentGrace(COMPLETING_DOCTOR, visit, at(AMENDMENT_GRACE_MS - 1))).toBe(true);
    // Exactly 24h is still inside. Both sides asserted, because "over a day is refused" says nothing
    // about where the boundary sits and an off-by-one there is invisible to a test that jumps a week.
    expect(withinAmendmentGrace(COMPLETING_DOCTOR, visit, at(AMENDMENT_GRACE_MS))).toBe(true);
    expect(withinAmendmentGrace(COMPLETING_DOCTOR, visit, at(AMENDMENT_GRACE_MS + 1))).toBe(false);
  });

  it("is the completing doctor's alone, and a colleague is refused inside it", () => {
    // The guard the founder asked for with the ruling. The window relaxes presence; it does not
    // widen who may reach the record, which is the permanent-access accumulation Q18 rejected.
    expect(withinAmendmentGrace(OTHER_DOCTOR, visit, at(60_000))).toBe(false);
    expect(withinAmendmentGrace(null, visit, at(60_000))).toBe(false);
  });

  it("a visit that was never completed has no window", () => {
    // A draft is written into, not amended, so there is no instant to measure from.
    expect(
      withinAmendmentGrace(COMPLETING_DOCTOR, { doctorId: COMPLETING_DOCTOR, completedAt: null }, at(0)),
    ).toBe(false);
  });
});
