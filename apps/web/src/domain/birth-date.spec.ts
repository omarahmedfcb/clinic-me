import { describe, expect, test } from "vitest";
import {
  birthDayOptions,
  birthYearOptions,
  daysInMonth,
  EMPTY_BIRTH_DATE,
  isoFromParts,
  partsFromIso,
} from "./birth-date.ts";

/**
 * Date of birth as three selects — Q31 as amended 2026-09-09.
 *
 * The amendment's whole claim is that a select cannot produce a date a person did not mean. So the
 * assertions worth having are the ones about what the lists **offer**: April has no 31st, February
 * has 29 only in a leap year, and the years run from this one backwards.
 *
 * `today` is a parameter everywhere, so the boundary between "yesterday" and "tomorrow" is testable
 * without waiting for midnight — the standing rule for anything whose answer depends on an instant.
 */

const TODAY = new Date("2026-09-09T10:00:00Z");

describe("what the three lists offer", () => {
  test("years run from the current one backwards, and the current year is first", () => {
    const years = birthYearOptions(TODAY);
    expect(years[0]).toBe("2026");
    expect(years[1]).toBe("2025");
    // A birthday is far more often recent than a century ago; a list starting at 1906 makes the
    // common case the longest scroll.
    expect(years.at(-1)).toBe("1906");
    expect(years).toHaveLength(121);
  });

  test("a month only offers the days it has", () => {
    expect(daysInMonth("4", "2026")).toBe(30);
    expect(daysInMonth("2", "2026")).toBe(28);
    // The one people get wrong, and the reason this is derived rather than a constant 31.
    expect(daysInMonth("2", "2024")).toBe(29);
    expect(birthDayOptions("4", "2026")).not.toContain("31");
    expect(birthDayOptions("1", "2026")).toContain("31");
  });

  test("with no year chosen, February offers 29", () => {
    // Offering 28 would refuse a real leap-year birthday the moment the year is picked. The parse
    // is what finally decides, and it is exact.
    expect(daysInMonth("2", "")).toBe(29);
  });
});

describe("the three parts as a calendar day", () => {
  test("a complete, real, past date resolves", () => {
    expect(isoFromParts({ day: "9", month: "4", year: "1990" }, TODAY)).toEqual({
      ok: true,
      iso: "1990-04-09",
    });
  });

  test("an unfinished choice is incomplete, not invalid", () => {
    // "Not finished choosing" must not read as "you typed something wrong": the required-field
    // message covers the first, and two errors on one control is noise.
    expect(isoFromParts(EMPTY_BIRTH_DATE, TODAY)).toEqual({ ok: false, problem: "INCOMPLETE" });
    expect(isoFromParts({ day: "9", month: "", year: "1990" }, TODAY)).toEqual({
      ok: false,
      problem: "INCOMPLETE",
    });
  });

  test("an impossible combination fails rather than rolling forward", () => {
    // 31 kept from a previous month after switching to February. Built in UTC and read back, so it
    // cannot silently become 3 March.
    expect(isoFromParts({ day: "31", month: "2", year: "2026" }, TODAY)).toEqual({
      ok: false,
      problem: "IMPOSSIBLE",
    });
    expect(isoFromParts({ day: "29", month: "2", year: "2026" }, TODAY)).toEqual({
      ok: false,
      problem: "IMPOSSIBLE",
    });
  });

  test("today is allowed and tomorrow is not, asserted at the boundary", () => {
    // A newborn registered on the day of birth is ordinary; "past years only" must not exclude it.
    expect(isoFromParts({ day: "9", month: "9", year: "2026" }, TODAY)).toEqual({
      ok: true,
      iso: "2026-09-09",
    });
    expect(isoFromParts({ day: "10", month: "9", year: "2026" }, TODAY)).toEqual({
      ok: false,
      problem: "FUTURE",
    });
  });
});

describe("a national ID fills all three", () => {
  test("ISO splits into parts a person can then correct", () => {
    // The autofill path: the parser reads a birthday out of the national ID and the three selects
    // must land on it, or staff would have to retype what the ID already said.
    expect(partsFromIso("1990-04-09")).toEqual({ day: "9", month: "4", year: "1990" });
  });

  test("nothing recorded leaves the three empty rather than guessing", () => {
    expect(partsFromIso(null)).toEqual(EMPTY_BIRTH_DATE);
    expect(partsFromIso("")).toEqual(EMPTY_BIRTH_DATE);
    expect(partsFromIso("not-a-date")).toEqual(EMPTY_BIRTH_DATE);
  });
});
