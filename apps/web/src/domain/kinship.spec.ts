import { describe, expect, test } from "vitest";
import { KINSHIPS, reciprocalOf } from "./kinship.ts";

/**
 * Q30. The reciprocal is derived, not asked twice — a receptionist told once that Ali is Mona's son
 * should not then be asked what Mona is to Ali.
 */

describe("spouse", () => {
  test("is its own mirror", () => {
    expect(reciprocalOf("HUSBAND", "FEMALE")).toBe("WIFE");
    expect(reciprocalOf("WIFE", "MALE")).toBe("HUSBAND");
  });

  test("does not depend on the other person's recorded sex", () => {
    // The relation already names both sides, so an unrecorded sex cannot make it ambiguous.
    expect(reciprocalOf("HUSBAND", null)).toBe("WIFE");
    expect(reciprocalOf("WIFE", null)).toBe("HUSBAND");
  });
});

describe("parent and child", () => {
  test("a child's reciprocal is the parent's own sex", () => {
    expect(reciprocalOf("SON", "MALE")).toBe("FATHER");
    expect(reciprocalOf("SON", "FEMALE")).toBe("MOTHER");
    expect(reciprocalOf("DAUGHTER", "MALE")).toBe("FATHER");
  });

  test("a parent's reciprocal is the child's own sex", () => {
    expect(reciprocalOf("FATHER", "MALE")).toBe("SON");
    expect(reciprocalOf("MOTHER", "FEMALE")).toBe("DAUGHTER");
  });

  test("an unrecorded sex yields no reciprocal rather than a guessed one", () => {
    // Legacy rows have no sex (D26 made it required only at intake). Inventing a father here would
    // be a fact nobody entered, which is the same falsification D26 refuses for birthdays.
    expect(reciprocalOf("SON", null)).toBeNull();
    expect(reciprocalOf("MOTHER", null)).toBeNull();
  });
});

describe("the mapping is total", () => {
  test("every kinship has a defined answer for a known sex", () => {
    // Guards the switch against a value added to KINSHIPS and not handled — which would return
    // undefined and store nothing, silently making the link one-directional.
    for (const relation of KINSHIPS) {
      expect(reciprocalOf(relation, "MALE")).not.toBeUndefined();
      expect(reciprocalOf(relation, "FEMALE")).not.toBeUndefined();
    }
  });
});
