import { eventReach } from "../../src/modules/audit/event-reach.ts";

describe("an audit event's label (BRANCHES-DESIGN §4.6)", () => {
  test("an event holding both a pre-branches row and an unscoped one reads as predating branches", () => {
    expect(eventReach(true, true, true)).toBe("BEFORE_BRANCHES");
  });

  test.each([
    [true, false, "BEFORE_BRANCHES"],
    [false, true, "UNSCOPED"],
    [false, false, null],
  ] as const)("in a multi-branch clinic, before branches %s and unscoped %s read as %s", (before, unscoped, expected) => {
    expect(eventReach(true, before, unscoped)).toBe(expected);
  });

  test("a single-branch clinic gets no label whatever the rows hold", () => {
    for (const [before, unscoped] of [[true, true], [true, false], [false, true]] as const) {
      expect(eventReach(false, before, unscoped)).toBeNull();
    }
  });
});
