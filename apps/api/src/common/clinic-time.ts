// Extracted from webchat-tools.ts on 2026-09-26 when whatsapp-tools.ts needed the identical
// functions -- pure formatting/parsing, no service or database import, so there was nothing
// channel-specific about them to begin with. Both tool registries import from here now rather than
// each carrying its own copy.

/** The clinic's local wall-clock time for an instant, e.g. `2026-09-25 10:00`. No arithmetic done
 *  by hand -- and none left for the model to get wrong either. */
export function formatInClinicTime(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(instant);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}`;
}

/** Today's date, in the clinic's own calendar rather than the server's. */
export function todayInClinic(timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/**
 * Accepts the date formats a patient (or the model, converting free text) is likely to produce:
 * ISO (2026-09-23), and Egypt's everyday day-first convention with either separator
 * (23-09-2026, 23/09/2026). Returns a normalised YYYY-MM-DD string, or null if it cannot be read as
 * a real calendar date -- the model is instructed to convert relative or worded dates itself before
 * calling the slots tool, so this only needs to cover the handful of literal shapes people actually type.
 */
export function parseFlexibleDate(input: string): string | null {
  const isoMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input);
  if (isoMatch) {
    const asDate = new Date(`${input}T00:00:00Z`);
    return Number.isNaN(asDate.getTime()) ? null : input;
  }

  const dayFirstMatch = /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/.exec(input);
  if (dayFirstMatch) {
    const [, day, month, year] = dayFirstMatch;
    const iso = `${year}-${month!.padStart(2, "0")}-${day!.padStart(2, "0")}`;
    const asDate = new Date(`${iso}T00:00:00Z`);
    return Number.isNaN(asDate.getTime()) ? null : iso;
  }

  return null;
}
