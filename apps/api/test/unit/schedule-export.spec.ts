import { scheduleToCsv } from "../../../web/src/features/schedules/export-spreadsheet.ts";
import type { WorkingHoursPattern } from "../../../web/src/features/schedules/pattern.ts";
import type { ScheduleException, ScheduleTemplate } from "../../../web/src/features/schedules/schedules-api.ts";

/**
 * The spreadsheet export.
 *
 * **This is CSV, not .xlsx.** The brief asked for "the xlsx approach we already have"; there is no
 * xlsx code in this repository — the only match anywhere is a companion financial model mentioned
 * in `docs/PRICING.md`, which the founder maintains by hand. Producing a real `.xlsx` needs either
 * a library (a dependency decision) or a hand-rolled ZIP writer, so this ships as CSV and the
 * choice is put to him rather than taken quietly.
 *
 * Tested here rather than by clicking a download, because the interesting part is the *content*
 * and the encoding, and a browser download proves neither.
 */

const PATTERN: WorkingHoursPattern = {
  startTime: "09:00",
  endTime: "17:00",
  validFrom: "2026-09-01",
  validTo: null,
  daysOff: [5, 6],
};

const WEEKDAYS = ["الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"] as const;

const LABELS = {
  doctor: "الطبيب",
  clinic: "العيادة",
  pattern: "ساعات العمل",
  validity: "فترة السريان",
  from: "من",
  to: "إلى",
  daysOff: "الإجازة الأسبوعية",
  weekly: "الجدول الأسبوعي",
  day: "اليوم",
  breaks: "استراحات",
  breakLabel: "الاسم",
  exceptions: "استثناءات",
  date: "التاريخ",
  type: "النوع",
  scope: "النطاق",
  clinicWide: "العيادة كلها",
  reason: "السبب",
  wholeDay: "اليوم كله",
  generatedAt: "تاريخ التصدير",
};

const templates: ScheduleTemplate[] = [
  {
    weekday: 0,
    startTime: "09:00",
    endTime: "17:00",
    validFrom: "2026-09-01",
    validTo: null,
    breaks: [{ startTime: "13:00", endTime: "14:00", label: "غداء" }],
  },
  { weekday: 4, startTime: "09:00", endTime: "18:00", validFrom: "2026-09-01", validTo: null, breaks: [] },
];

const exceptions: ScheduleException[] = [
  {
    id: "e1",
    doctorId: null,
    date: "2026-09-10",
    type: "HOLIDAY",
    startTime: null,
    endTime: null,
    reason: "إجازة رسمية",
  },
  {
    id: "e2",
    doctorId: "d1",
    date: "2026-09-03",
    type: "BLOCKED",
    startTime: "11:00",
    endTime: "13:00",
    reason: 'مؤتمر, "طبي"',
  },
];

const csv = (): string =>
  scheduleToCsv({
    doctorName: "د. هشام",
    clinicName: "عيادة النيل",
    pattern: PATTERN,
    templates,
    exceptions,
    weekdayNames: WEEKDAYS,
    labels: LABELS,
    generatedAt: new Date("2026-08-29T07:00:00Z"),
  });

describe("schedule spreadsheet export", () => {
  /**
   * The single most important character in the file. Excel guesses a CSV's encoding, and without a
   * UTF-8 byte-order mark it guesses the system codepage and renders every Arabic string as
   * mojibake — which a receptionist reads as "the export is broken", not "Excel guessed wrong".
   */
  it("starts with a UTF-8 BOM so Excel reads Arabic correctly", () => {
    expect(csv().charCodeAt(0)).toBe(0xfeff);
  });

  it("uses CRLF, which is what Excel on Windows expects", () => {
    expect(csv()).toContain("\r\n");
  });

  it("carries all four sections", () => {
    const out = csv();
    for (const heading of [LABELS.pattern, LABELS.weekly, LABELS.exceptions, LABELS.clinic]) {
      expect(out).toContain(heading);
    }
  });

  it("includes the validity period and the days off by name", () => {
    const out = csv();
    expect(out).toContain("2026-09-01");
    expect(out).toContain("الجمعة");
    expect(out).toContain("السبت");
  });

  it("includes each working day with its hours and breaks", () => {
    const out = csv();
    expect(out).toContain("الأحد,09:00,17:00,13:00–14:00 (غداء)");
    expect(out).toContain("الخميس,09:00,18:00,");
  });

  it("marks a clinic-wide exception as such rather than naming the doctor", () => {
    const out = csv();
    expect(out).toContain(`2026-09-10,HOLIDAY,${LABELS.clinicWide}`);
    expect(out).toContain("2026-09-03,BLOCKED,د. هشام");
  });

  it("shows a whole-day exception as whole-day rather than as an empty time", () => {
    expect(csv()).toContain(`${LABELS.clinicWide},${LABELS.wholeDay}`);
  });

  /**
   * RFC 4180. A reason containing a comma and quotes is ordinary in free text, and getting this
   * wrong shifts every later column on that row — silently, and only for the rows a human typed.
   */
  it("escapes a value containing a comma and quotes", () => {
    expect(csv()).toContain('"مؤتمر, ""طبي"""');
  });

  it("sorts exceptions by date rather than by insertion order", () => {
    const out = csv();
    expect(out.indexOf("2026-09-03")).toBeLessThan(out.indexOf("2026-09-10"));
  });

  /** `generatedAt` is a parameter, so the export is reproducible rather than clock-dependent. */
  it("does not read the clock", () => {
    expect(csv()).toContain("2026-08-29 07:00");
  });
});
