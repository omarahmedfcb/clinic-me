import { describe, expect, test } from "vitest";
import {
  nationalIdDisagreements,
  parseEgyptianNationalId,
} from "./egyptian-national-id.ts";

/**
 * The national ID parser — `SCHEMA-DECISIONS.md` D27.
 *
 * Pure, so it is tested here rather than through an endpoint. The cases that matter are the
 * rejections: a parser that accepts anything fourteen digits long would auto-fill a patient's
 * birthday with a number somebody fat-fingered, and the screen would present it as read off a card.
 */

describe("parsing a valid ID", () => {
  test("reads the birth date, gender and governorate", () => {
    // 2 = 1900s, 900101 = 1990-01-01, 01 = القاهرة.
    const result = parseEgyptianNationalId("29001010123456");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.facts.dateOfBirth).toBe("1990-01-01");
    expect(result.facts.governorateCode).toBe("01");
    expect(result.facts.governorate).toBe("القاهرة");
  });

  test("century 3 is the 2000s", () => {
    const result = parseEgyptianNationalId("30512310212345");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.facts.dateOfBirth).toBe("2005-12-31");
    expect(result.facts.governorate).toBe("الإسكندرية");
  });

  test("the thirteenth digit decides gender: odd male, even female", () => {
    // Index 12 of "29001010123456" is 5 — odd, so male. The two IDs differ only in that digit.
    const male = parseEgyptianNationalId("29001010123456");
    const female = parseEgyptianNationalId("29001010123446");
    expect(male.ok && male.facts.gender).toBe("MALE");
    expect(female.ok && female.facts.gender).toBe("FEMALE");
  });

  test("88 is a birth outside the country, which is a real card and not an error", () => {
    const result = parseEgyptianNationalId("29001018812345");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.facts.governorate).toBe("خارج الجمهورية");
  });
});

describe("what it refuses", () => {
  test.each([
    ["too short", "2900101012345", "LENGTH"],
    ["too long", "290010101234567", "LENGTH"],
    ["Arabic-Indic digits, which a keyboard produces", "٢٩٠٠١٠١٠١٢٣٤٥٦", "NOT_DIGITS"],
    ["letters", "2900101012345A", "NOT_DIGITS"],
    ["century 1, which no card carries", "19001010123456", "CENTURY"],
    ["month 13", "29013010123456", "DATE"],
    ["31 February, which a naive Date would roll into March", "29002310123456", "DATE"],
    ["day 00", "29001000123456", "DATE"],
    ["governorate 05, which does not exist", "29001010523456", "GOVERNORATE"],
  ])("%s", (_label, input, problem) => {
    const result = parseEgyptianNationalId(input);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problem).toBe(problem);
  });
});

describe("disagreement is reported, never enforced", () => {
  const facts = {
    dateOfBirth: "1990-01-01",
    gender: "FEMALE" as const,
    governorateCode: "01",
    governorate: "القاهرة",
  };

  test("a corrected birth date is flagged, not rejected", () => {
    // D27: the ID is evidence. A mistyped digit must not overwrite a date read off a passport.
    expect(nationalIdDisagreements(facts, { dateOfBirth: "1991-01-01" })).toEqual(["dateOfBirth"]);
  });

  test("agreement reports nothing, including when a timestamp is passed", () => {
    expect(nationalIdDisagreements(facts, { dateOfBirth: "1990-01-01T00:00:00Z", gender: "FEMALE" })).toEqual([]);
  });

  test("fields nobody entered are not disagreements", () => {
    expect(nationalIdDisagreements(facts, { dateOfBirth: null, gender: undefined })).toEqual([]);
  });
});
