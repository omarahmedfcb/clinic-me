import { BRAND } from "../../brand/brand.ts";
import type { WeekDay } from "./schedules-api.ts";

/**
 * The doctor's week as an `.ics` file — RFC 5545, no dependency.
 *
 * ## Busy blocks only. No patient names, ever.
 *
 * This is the decision from `PHASE-2.md` §14 and it is not a detail of this file, it is the
 * file's purpose. Each event carries a start, an end, and the word "موعد". No name, no phone, no
 * complaint, no service.
 *
 * The reason is not distrust of the doctor's phone. **Calendar applications sync their contents to
 * their vendor's servers** — Apple's, Google's — so whatever this file contains ends up on
 * infrastructure we have no agreement with, regardless of who opened it. Under PDPL that would be
 * health data reaching a third-party processor. A busy block is a work pattern; a named event is a
 * patient list.
 *
 * The doctor loses nothing they need: the calendar's job is to stop them double-booking themselves
 * at their other clinic, and a busy block does that completely. The names are in the app, behind a
 * login.
 *
 * ## A download, not a subscription
 *
 * This is a snapshot. Cancel an appointment and the doctor's calendar keeps showing it until they
 * download again — which is a real limitation and the reason §14 designs a subscription feed as
 * the eventual answer. That feed is unbuilt pending a ruling on its token model, so this ships as
 * the honest lesser thing rather than as nothing.
 *
 * ## Times are UTC
 *
 * `DTSTART:20260901T070000Z` rather than `DTSTART;TZID=Africa/Cairo:...`. A `TZID` reference
 * obliges the file to carry a `VTIMEZONE` block defining Egypt's DST rules — which change, which
 * would then be frozen into every file ever downloaded, and which is exactly the class of stale
 * guarantee this project keeps finding. An absolute instant cannot go stale; every calendar
 * application renders it in the viewer's own zone.
 */

/** RFC 5545 §3.3.5: basic-format UTC, `YYYYMMDDTHHMMSSZ`. */
function icsInstant(value: Date): string {
  return `${value.toISOString().replace(/[-:]/g, "").slice(0, 15)}Z`;
}

/** RFC 5545 §3.3.11: backslash, semicolon and comma are escaped; newlines become `\n`. */
function escapeText(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

/**
 * RFC 5545 §3.1: content lines are folded at 75 **octets**, not characters.
 *
 * That distinction is the whole reason this function is careful. Arabic is multi-byte in UTF-8, so
 * folding by character length would produce lines over the limit, and splitting mid-sequence would
 * corrupt the text. This measures in bytes and never breaks a character in half.
 */
function fold(line: string): string {
  const encoder = new TextEncoder();
  if (encoder.encode(line).length <= 75) return line;

  const out: string[] = [];
  let current = "";
  let bytes = 0;
  // Iterating the string yields whole code points, so a character is never split.
  for (const char of line) {
    const size = encoder.encode(char).length;
    // Continuation lines start with a space, which counts toward the 75.
    const limit = out.length === 0 ? 75 : 74;
    if (bytes + size > limit) {
      out.push(current);
      current = "";
      bytes = 0;
    }
    current += char;
    bytes += size;
  }
  if (current !== "") out.push(current);
  return out.join("\r\n ");
}

export interface CalendarInput {
  days: WeekDay[];
  doctorName: string;
  clinicName: string;
  /** What every event is called. No patient identity — see the note above. */
  busyLabel: string;
  /** Passed in rather than read from the clock, so the output is reproducible in a test. */
  generatedAt: Date;
}

export function weekToIcs(input: CalendarInput): string {
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    // The product name a calendar app shows as the source. The UID below keeps `clinic-os`: it is
    // an identifier, and changing it would make every re-import duplicate instead of update.
    `PRODID:-//Rahal Group//${BRAND.name}//AR`,
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeText(`${input.doctorName} — ${input.clinicName}`)}`,
  ];

  const stamp = icsInstant(input.generatedAt);

  for (const day of input.days) {
    for (const block of day.busy) {
      lines.push(
        "BEGIN:VEVENT",
        // Stable per appointment, so re-importing updates the event rather than duplicating it.
        `UID:${block.appointmentId}@clinic-os`,
        `DTSTAMP:${stamp}`,
        `DTSTART:${icsInstant(new Date(block.start))}`,
        `DTEND:${icsInstant(new Date(block.end))}`,
        `SUMMARY:${escapeText(input.busyLabel)}`,
        // OPAQUE marks the time as busy, which is the entire point of the file.
        "TRANSP:OPAQUE",
        "END:VEVENT",
      );
    }
  }

  lines.push("END:VCALENDAR");
  // CRLF between lines, per RFC 5545, and a trailing one.
  return lines.map(fold).join("\r\n") + "\r\n";
}
