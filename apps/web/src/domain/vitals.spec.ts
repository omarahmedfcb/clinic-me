import { describe, expect, test } from "vitest";
import { delta, isImplausible, parseVital, showsHeadCircumference } from "./vitals.ts";

/**
 * Vitals parsing and comparison — `PHASE-4-PLAN.md` PR 7b.
 *
 * The case that matters is the empty one. A blank field means "not measured", and turning it into 0
 * would record a newborn's weight as zero and a temperature as freezing — a stored fact nobody
 * entered, of exactly the kind D26 refuses to backfill.
 */

describe("parsing", () => {
  test("a blank field is not measured, never zero", () => {
    expect(parseVital("")).toBeNull();
    expect(parseVital("   ")).toBeNull();
  });

  test("a real zero is kept, because 0 is a legitimate reading for some fields", () => {
    expect(parseVital("0")).toBe(0);
  });

  test("decimals and surrounding space survive", () => {
    expect(parseVital(" 36.6 ")).toBe(36.6);
  });

  test("nonsense is not a number", () => {
    expect(parseVital("abc")).toBeNull();
    expect(parseVital("--")).toBeNull();
  });
});

describe("plausibility warns, never refuses", () => {
  test("a slipped decimal is caught", () => {
    // 720 kg is a typo for 72.0; the form warns and still lets it be saved.
    expect(isImplausible("weightKg", 720)).toBe(true);
    expect(isImplausible("temperatureC", 366)).toBe(true);
  });

  test("genuinely extreme but real values are accepted", () => {
    expect(isImplausible("weightKg", 0.9)).toBe(false);
    expect(isImplausible("systolic", 220)).toBe(false);
    expect(isImplausible("temperatureC", 41.5)).toBe(false);
  });
});

describe("head circumference is paediatric", () => {
  test("offered under five, hidden at five and above", () => {
    expect(showsHeadCircumference(0)).toBe(true);
    expect(showsHeadCircumference(4)).toBe(true);
    expect(showsHeadCircumference(5)).toBe(false);
    expect(showsHeadCircumference(40)).toBe(false);
  });

  test("an unknown age does not offer it", () => {
    // A patient with no date of birth: guessing that they are a child would put a field on the
    // screen for the wrong reason. D26's badge is what asks for the missing birthday.
    expect(showsHeadCircumference(null)).toBe(false);
  });
});

describe("comparison with the previous visit", () => {
  test("a difference is reported", () => {
    expect(delta(72.5, 70)).toBe(2.5);
    expect(delta(70, 72.5)).toBe(-2.5);
  });

  test("no previous value means no trend, not a gain of the whole amount", () => {
    expect(delta(72.5, undefined)).toBeNull();
    expect(delta(undefined, 70)).toBeNull();
  });
});
