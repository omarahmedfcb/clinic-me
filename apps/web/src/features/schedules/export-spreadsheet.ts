import type { WorkingHoursPattern } from "./pattern.ts";
import type { ScheduleException, ScheduleTemplate } from "./schedules-api.ts";

/**
 * The schedule as a spreadsheet.
 *
 * ## This is CSV, not .xlsx, and that is a flag rather than a decision
 *
 * The brief said to "use the xlsx approach we already have". **There is no xlsx code in this
 * repository.** The only match anywhere is `docs/PRICING.md` mentioning a companion financial model
 * the founder maintains by hand — a document, not a code path. Searched before assuming.
 *
 * A real `.xlsx` is a ZIP of XML parts. Producing one needs either a library (`exceljs`, `xlsx`) —
 * which CLAUDE.md says to ask about before adding — or a hand-rolled ZIP writer with CRC32 and
 * central-directory records, roughly a hundred and twenty lines of binary fiddling that would then
 * be ours to own for one export button. Neither is a call to make quietly, so this ships as CSV
 * and the choice is put to the founder.
 *
 * CSV is not a poor substitute here. Excel opens it, the four sections survive, and it is a text
 * format anyone can inspect. What it loses is multiple sheets, column widths and formatting.
 *
 * ## The BOM is not optional
 *
 * Every string in this file is Arabic. Excel guesses the encoding of a CSV, and without a UTF-8
 * byte-order mark it guesses the system codepage and renders مواعيد as mojibake — which reads as
 * "the export is broken" rather than "Excel guessed wrong". The BOM makes it read the file as
 * UTF-8 and is the single most important character in this module.
 */

const BOM = "﻿";

/** RFC 4180: quote everything containing a delimiter, quote or newline; double interior quotes. */
function cell(value: string | number | null): string {
  const text = value === null ? "" : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

const row = (cells: (string | number | null)[]): string => cells.map(cell).join(",");

export interface SpreadsheetInput {
  doctorName: string;
  clinicName: string;
  pattern: WorkingHoursPattern;
  templates: ScheduleTemplate[];
  exceptions: ScheduleException[];
  /** Arabic weekday names, indexed by JS `getDay()`. Passed in so this file holds no strings. */
  weekdayNames: readonly string[];
  labels: {
    doctor: string;
    clinic: string;
    pattern: string;
    validity: string;
    from: string;
    to: string;
    daysOff: string;
    weekly: string;
    day: string;
    breaks: string;
    breakLabel: string;
    exceptions: string;
    date: string;
    type: string;
    scope: string;
    clinicWide: string;
    reason: string;
    wholeDay: string;
    generatedAt: string;
  };
  /** Passed in rather than read from the clock, so an export is reproducible in a test. */
  generatedAt: Date;
}

/**
 * Four sections in one sheet, separated by blank lines — the ordinary shape of a CSV export that
 * carries more than one table. A reader sees the whole arrangement without opening four files.
 */
export function scheduleToCsv(input: SpreadsheetInput): string {
  const { pattern, templates, exceptions, weekdayNames, labels } = input;
  const lines: string[] = [];

  lines.push(row([labels.clinic, input.clinicName]));
  lines.push(row([labels.doctor, input.doctorName]));
  lines.push(row([labels.generatedAt, input.generatedAt.toISOString().slice(0, 16).replace("T", " ")]));
  lines.push("");

  lines.push(row([labels.pattern]));
  lines.push(row([labels.from, pattern.startTime, labels.to, pattern.endTime]));
  lines.push(row([labels.validity, pattern.validFrom, labels.to, pattern.validTo ?? ""]));
  lines.push(row([labels.daysOff, pattern.daysOff.map((d) => weekdayNames[d] ?? String(d)).join(" · ")]));
  lines.push("");

  lines.push(row([labels.weekly]));
  lines.push(row([labels.day, labels.from, labels.to, labels.breaks]));
  for (const template of [...templates].sort((a, b) => a.weekday - b.weekday)) {
    const breaks = template.breaks
      .map((b) => `${b.startTime}–${b.endTime}${b.label === "" ? "" : ` (${b.label})`}`)
      .join(" · ");
    lines.push(
      row([weekdayNames[template.weekday] ?? String(template.weekday), template.startTime, template.endTime, breaks]),
    );
  }
  lines.push("");

  lines.push(row([labels.exceptions]));
  lines.push(row([labels.date, labels.type, labels.scope, labels.from, labels.to, labels.reason]));
  for (const exception of [...exceptions].sort((a, b) => a.date.localeCompare(b.date))) {
    lines.push(
      row([
        exception.date,
        exception.type,
        exception.doctorId === null ? labels.clinicWide : input.doctorName,
        exception.startTime ?? labels.wholeDay,
        exception.endTime ?? "",
        exception.reason ?? "",
      ]),
    );
  }

  // CRLF, because Excel on Windows is the reader this exists for.
  return BOM + lines.join("\r\n") + "\r\n";
}
