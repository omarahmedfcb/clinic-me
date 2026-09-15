import { weekToIcs } from "../../../web/src/features/schedules/export-calendar.ts";
import type { WeekDay } from "../../../web/src/features/schedules/schedules-api.ts";

/**
 * The `.ics` export.
 *
 * The assertion that matters most is a **negative** one: no patient name, phone or complaint
 * appears anywhere in the output. Calendar applications sync their contents to their vendor's
 * servers, so anything in this file reaches infrastructure we have no agreement with, whoever
 * opened it — under PDPL that would be health data reaching a third-party processor. A busy block
 * is a work pattern; a named event is a patient list. PHASE-2.md §14.
 */

const days: WeekDay[] = [
  {
    date: "2026-09-01",
    working: [{ start: "2026-09-01T06:00:00.000Z", end: "2026-09-01T11:00:00.000Z", utcOffsetMinutes: 180 }],
    busy: [
      { start: "2026-09-01T06:00:00.000Z", end: "2026-09-01T06:30:00.000Z", appointmentId: "appt-1" },
      { start: "2026-09-01T07:00:00.000Z", end: "2026-09-01T07:30:00.000Z", appointmentId: "appt-2" },
    ],
    free: [],
    fullyBooked: false,
  },
  { date: "2026-09-02", working: [], busy: [], free: [], fullyBooked: false },
];

const ics = (over: Partial<Parameters<typeof weekToIcs>[0]> = {}): string =>
  weekToIcs({
    days,
    doctorName: "د. هشام محمود الديب",
    clinicName: "عيادة النيل لطب الأسرة",
    busyLabel: "موعد",
    generatedAt: new Date("2026-08-29T13:45:00Z"),
    ...over,
  });

describe("calendar export", () => {
  it("is a well-formed VCALENDAR", () => {
    const out = ics();
    expect(out.startsWith("BEGIN:VCALENDAR\r\n")).toBe(true);
    expect(out.trimEnd().endsWith("END:VCALENDAR")).toBe(true);
    expect(out).toContain("VERSION:2.0");
  });

  it("emits one event per busy block and none for a day off", () => {
    const out = ics();
    expect(out.match(/BEGIN:VEVENT/g)).toHaveLength(2);
    expect(out.match(/END:VEVENT/g)).toHaveLength(2);
  });

  /**
   * The whole point of the file. Written as a scan for anything patient-shaped rather than as a
   * check for two specific strings, so a future field added to the event fails here.
   */
  it("carries no patient identity of any kind", () => {
    const out = weekToIcs({
      days,
      doctorName: "د. هشام",
      clinicName: "عيادة النيل",
      busyLabel: "موعد",
      generatedAt: new Date("2026-08-29T13:45:00Z"),
    });

    for (const forbidden of ["ATTENDEE", "DESCRIPTION", "LOCATION", "CONTACT", "ORGANIZER"]) {
      expect(out).not.toContain(forbidden);
    }
    // Every SUMMARY is the generic label and nothing else.
    for (const summary of out.match(/^SUMMARY:.*$/gm) ?? []) {
      expect(summary).toBe("SUMMARY:موعد");
    }
  });

  it("uses absolute UTC instants rather than a TZID reference", () => {
    const out = ics();
    expect(out).toContain("DTSTART:20260901T060000Z");
    expect(out).toContain("DTEND:20260901T063000Z");
    // A TZID would oblige a VTIMEZONE block freezing Egypt's DST rules into every file ever
    // downloaded — a stale guarantee by construction.
    expect(out).not.toContain("TZID");
    expect(out).not.toContain("VTIMEZONE");
  });

  it("gives each appointment a stable UID so re-importing updates rather than duplicates", () => {
    const out = ics();
    expect(out).toContain("UID:appt-1@clinic-os");
    expect(out).toContain("UID:appt-2@clinic-os");
  });

  it("marks the time busy", () => {
    expect(ics().match(/TRANSP:OPAQUE/g)).toHaveLength(2);
  });

  it("does not read the clock", () => {
    expect(ics()).toContain("DTSTAMP:20260829T134500Z");
  });

  describe("RFC 5545 text rules", () => {
    it("escapes commas, semicolons and backslashes", () => {
      const out = ics({ busyLabel: "موعد, عاجل; مع \\ملاحظة" });
      expect(out).toContain("SUMMARY:موعد\\, عاجل\\; مع \\\\ملاحظة");
    });

    /**
     * Folding is at 75 **octets**, not characters. Arabic is multi-byte in UTF-8, so a
     * character-length fold produces over-long lines and a naive byte slice corrupts a character
     * mid-sequence. This is the case that catches both.
     */
    it("folds long Arabic lines by byte length without splitting a character", () => {
      const long = "عيادة".repeat(30);
      const out = ics({ clinicName: long });
      const encoder = new TextEncoder();

      for (const line of out.split("\r\n")) {
        expect(encoder.encode(line).length).toBeLessThanOrEqual(75);
      }
      // Unfolding restores the original text exactly — nothing was lost or mangled.
      expect(out.replace(/\r\n /g, "")).toContain(long);
    });

    it("separates lines with CRLF", () => {
      expect(ics()).toContain("\r\n");
      expect(ics().split("\r\n").some((l) => l.includes("\n"))).toBe(false);
    });
  });

  it("produces a valid empty calendar when nothing is booked", () => {
    const out = ics({ days: [{ date: "2026-09-01", working: [], busy: [], free: [], fullyBooked: false }] });
    expect(out).toContain("BEGIN:VCALENDAR");
    expect(out).not.toContain("BEGIN:VEVENT");
  });
});
