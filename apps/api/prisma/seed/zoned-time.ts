/**
 * Wall-clock-in-a-timezone to UTC instant.
 *
 * A clinic's working day is "09:00 to 14:00" in the clinic's own timezone, but `scheduled_start`
 * is `timestamptz` -- an absolute instant. Converting between the two is the only place the seed
 * needs to know about timezones at all, and CLAUDE.md's rule is that the zone is a parameter,
 * never a literal in code: the value comes from `Tenant.timezone`, which the blueprint sets as
 * seed data (the one place a zone name is allowed to appear).
 *
 * Egypt observes DST, so a fixed +02:00 offset would silently shift every appointment by an hour
 * for part of the seeded three-month window. This resolves the real offset for each instant via
 * `Intl`, which reads the system's IANA database and therefore stays correct across DST
 * transitions and future rule changes.
 *
 * No dependency is added for this: `Intl.DateTimeFormat` is built in, and the whole conversion is
 * about thirty lines. Pulling in a date library for one function would be a decision to bring to
 * the founder, not one to make silently.
 */

const PARTS_FORMAT_CACHE = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = PARTS_FORMAT_CACHE.get(timeZone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    PARTS_FORMAT_CACHE.set(timeZone, formatter);
  }
  return formatter;
}

/**
 * How far ahead of UTC `timeZone` is at the given instant, in milliseconds. Positive east of
 * Greenwich, so Cairo returns +2h in winter and +3h under DST.
 */
function offsetMsAt(instant: Date, timeZone: string): number {
  const parts = formatterFor(timeZone).formatToParts(instant);
  const read = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((candidate) => candidate.type === type);
    if (part === undefined) {
      throw new Error(`zoned-time: Intl returned no "${type}" part for timezone "${timeZone}".`);
    }
    return Number(part.value);
  };

  // Intl formats hour 24 rather than 0 for midnight in some engines; % 24 normalises it.
  const asUtc = Date.UTC(read("year"), read("month") - 1, read("day"), read("hour") % 24, read("minute"), read("second"));
  return asUtc - instant.getTime();
}

/**
 * The UTC instant at which the clock in `timeZone` reads the given local date and time.
 *
 * Two passes, because the offset itself depends on the instant we are trying to find. The first
 * pass guesses using the offset at the naive-UTC interpretation; the second corrects it using the
 * offset actually in force at that guess. That resolves every case except a wall-clock time
 * inside a spring-forward gap, which does not exist -- the seed only ever asks for clinic working
 * hours, and no jurisdiction moves its clocks mid-morning.
 */
export function zonedWallClockToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  const naive = Date.UTC(year, month - 1, day, hour, minute, 0);
  const firstGuess = new Date(naive - offsetMsAt(new Date(naive), timeZone));
  return new Date(naive - offsetMsAt(firstGuess, timeZone));
}

/** A `@db.Date` column value: midnight UTC on the given calendar date, which is how Prisma maps DATE. */
export function dateOnly(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month - 1, day));
}

/** A `@db.Time(0)` column value. Prisma maps TIME through a Date whose date part is ignored. */
export function timeOnly(hour: number, minute: number): Date {
  return new Date(Date.UTC(1970, 0, 1, hour, minute, 0));
}
