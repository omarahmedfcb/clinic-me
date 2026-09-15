import { describe, expect, test } from "vitest";
import {
  fileReference,
  printedDate,
  printedPatientName,
  printedSex,
  printedTime,
  sickLeaveEnd,
} from "./print-english.ts";

/**
 * The decisions behind an English sheet — Q45, Q46.
 *
 * These are the parts where being wrong is silent: a name that falls back to the wrong source, a
 * date that reads differently depending on which JavaScript engine rendered it, and an end date
 * that is off by one on a document an employer counts days from.
 */

describe("which name goes on an English sheet", () => {
  const base = { fullNameAr: "مريم حسن عبد الله" };

  test("the recorded English name wins", () => {
    expect(
      printedPatientName({ ...base, fullNameEn: "Maryam Hassan", nameSearchLatin: "ignored" }),
    ).toEqual({ name: "Maryam Hassan", source: "english" });
  });

  test("otherwise the transliteration search already maintains", () => {
    // Not a new transliterator: `name_search_latin` is the one the patient search built (D19), so
    // the sheet and the search agree about how this patient's name is spelled in Latin.
    expect(
      printedPatientName({ ...base, fullNameEn: null, nameSearchLatin: "maryam hassan abdullah" }),
    ).toEqual({ name: "MARYAM HASSAN ABDULLAH", source: "transliteration" });
  });

  test("blank is treated as absent, not as a name", () => {
    // A whitespace-only English name would otherwise print as an empty line where the patient's
    // name belongs, which looks like a rendering fault rather than missing data.
    expect(printedPatientName({ ...base, fullNameEn: "   ", nameSearchLatin: "  " })).toEqual({
      name: "مريم حسن عبد الله",
      source: "arabic",
    });
  });

  test("the Arabic name is the last resort, and it is a name rather than a blank", () => {
    expect(printedPatientName({ ...base, fullNameEn: null, nameSearchLatin: null })).toEqual({
      name: "مريم حسن عبد الله",
      source: "arabic",
    });
  });
});

describe("dates on paper", () => {
  test("are written out, not left to Intl", () => {
    // `toLocaleDateString("en-GB", { month: "short" })` gives "Sept" on Node's ICU and "Sep" in
    // some browsers. The same visit printing differently depending on where the page ran is not
    // acceptable on a document a patient carries.
    expect(printedDate("2026-09-09T00:00:00.000Z")).toBe("09 Sep 2026");
    expect(printedDate("2026-01-01T00:00:00.000Z")).toBe("01 Jan 2026");
    expect(printedDate("2026-12-31T00:00:00.000Z")).toBe("31 Dec 2026");
  });

  test("a plain calendar day prints as that day", () => {
    // A DATE column arrives as UTC midnight; reading it in a negative offset would print the day
    // before, which is why this is read in UTC.
    expect(printedDate("2026-09-09")).toBe("09 Sep 2026");
  });

  test("nothing and nonsense both print as empty rather than as an Invalid Date", () => {
    expect(printedDate(null)).toBe("");
    expect(printedDate("not-a-date")).toBe("");
    expect(printedTime("not-a-date")).toBe("");
  });
});

describe("the sick-leave period", () => {
  test("is inclusive of the first day", () => {
    // Three days from Wednesday ends on Friday. An employer reads the two dates and counts them,
    // so an off-by-one here is a day of someone's pay.
    expect(sickLeaveEnd("2026-09-09", 3)).toBe("11 Sep 2026");
  });

  test("one day starts and ends on the same day", () => {
    expect(sickLeaveEnd("2026-09-09", 1)).toBe("09 Sep 2026");
  });

  test("crosses a month boundary correctly", () => {
    expect(sickLeaveEnd("2026-09-29", 5)).toBe("03 Oct 2026");
  });
});

describe("the rest of the patient block", () => {
  test("the clinic's own file number is what prints", () => {
    // Phase 5 PR 2: per clinic and sequential, which is what a receptionist reads down a phone.
    const id = "0192f2c3-4a5b-7c8d-9e0f-112233445566";
    expect(fileReference({ patientId: id, fileNumber: 137 })).toBe("137");
  });

  test("a payload without one falls back to a stable reference rather than a blank", () => {
    // An API older than the column would otherwise leave a hole where the patient's identifier
    // belongs, and a sheet that cannot identify its patient is not a document.
    const id = "0192f2c3-4a5b-7c8d-9e0f-112233445566";
    expect(fileReference({ patientId: id })).toBe("33445566");
    expect(fileReference({ patientId: id, fileNumber: null })).toBe("33445566");
  });

  test("sex is a word, never the stored enum", () => {
    expect(printedSex("MALE")).toBe("Male");
    expect(printedSex("FEMALE")).toBe("Female");
    // Unrecorded prints as nothing rather than as "null" on a clinical form.
    expect(printedSex(null)).toBe("");
  });
});
