/**
 * Wall clock in a timezone, to instants — the one place the slot engine consults a timezone.
 *
 * `Intl.DateTimeFormat` only, no dependency. PHASE-2.md Q4 accepts that this makes the engine
 * deterministic *given the IANA rules in effect* rather than absolutely, because pinning a tzdb
 * version would turn a real government change into silently wrong appointment times. A dependency
 * here would also be the first exception the `domain/` source scan had to make, and the scan's
 * value is that `domain/` imports nothing at all.
 *
 * ## Why this is not `prisma/seed/zoned-time.ts`
 *
 * The seed has a similar function and says of the spring-forward gap: "which does not exist -- the
 * seed only ever asks for clinic working hours, and no jurisdiction moves its clocks mid-morning."
 * That is true for the seed and false here. **Egypt moves its clocks at midnight**, and PHASE-2.md
 * Q8 rules that sessions crossing midnight are supported — so this engine asks about exactly the
 * local times the seed's version was allowed to ignore. It returns *every* instant matching a
 * local time (nought, one, or two) instead of guessing one, and the difference is the whole point.
 *
 * The duplication is deliberate: importing the seed's version into `domain/` would drag a
 * different module's assumptions into the one place they are wrong.
 */

const FORMATTER_CACHE = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = FORMATTER_CACHE.get(timeZone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23", // not hour12:false -- some engines render midnight as hour 24 under that
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    FORMATTER_CACHE.set(timeZone, formatter);
  }
  return formatter;
}

interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function localPartsAt(instant: Date, timeZone: string): LocalParts {
  const parts = formatterFor(timeZone).formatToParts(instant);
  const read = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((candidate) => candidate.type === type);
    if (part === undefined) {
      throw new Error(`zoned-time: Intl returned no "${type}" part for timezone "${timeZone}".`);
    }
    return Number(part.value);
  };
  return {
    year: read("year"),
    month: read("month"),
    day: read("day"),
    hour: read("hour") % 24,
    minute: read("minute"),
    second: read("second"),
  };
}

/** Minutes `timeZone` is ahead of UTC at this instant. Cairo: +120 in winter, +180 under DST. */
export function offsetMinutesAt(instant: Date, timeZone: string): number {
  const p = localPartsAt(instant, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return (asUtc - instant.getTime()) / 60_000;
}

/**
 * The calendar date (`YYYY-MM-DD`) a clock in `timeZone` is showing at this instant.
 *
 * Exported for the insurance module, which asks "is this policy in force *today*" and must answer
 * it on the clinic's calendar rather than UTC's: a policy lapsing on the 31st is still valid at
 * 01:00 Cairo on the 31st, which is 23:00 UTC on the 30th. Both the instant and the zone are
 * parameters, so nothing here reads the clock (CLAUDE.md).
 */
export function calendarDayIn(instant: Date, timeZone: string): string {
  const parts = localPartsAt(instant, timeZone);
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
}

/** `YYYY-MM-DD` plus a whole number of days, as `YYYY-MM-DD`. Pure calendar arithmetic, no zone. */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const shifted = new Date(Date.UTC(y, m - 1, d + days));
  return shifted.toISOString().slice(0, 10);
}

/** JS `getDay()` semantics — Sunday = 0 (PHASE-2.md Q5) — for a calendar date, zone-independent. */
export function weekdayOf(date: string): number {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/**
 * Every instant at which the clock in `timeZone` reads this local date and time.
 *
 * - **one** — the ordinary case
 * - **two** — an ambiguous local time, during a fall-back. Both are real (PHASE-2.md Q3)
 * - **none** — a nonexistent local time, inside a spring-forward gap
 *
 * Two guesses, because the offset depends on the instant being solved for; each is then verified
 * by formatting it back. Verification is what makes the nought/two cases distinguishable at all —
 * a single-guess implementation returns something plausible for a local time that never happened.
 */
export function instantsForLocal(
  date: string,
  minutesFromMidnight: number,
  timeZone: string,
): Date[] {
  const dayShift = Math.floor(minutesFromMidnight / 1440);
  const within = minutesFromMidnight - dayShift * 1440;
  const target = addDays(date, dayShift);
  const [y, m, d] = target.split("-").map(Number) as [number, number, number];
  const hour = Math.floor(within / 60);
  const minute = within % 60;

  const naive = Date.UTC(y, m - 1, d, hour, minute, 0);
  const first = new Date(naive - offsetMinutesAt(new Date(naive), timeZone) * 60_000);
  const second = new Date(naive - offsetMinutesAt(first, timeZone) * 60_000);

  const seen = new Set<number>();
  const valid: Date[] = [];
  for (const candidate of [first, second]) {
    if (seen.has(candidate.getTime())) continue;
    seen.add(candidate.getTime());
    const p = localPartsAt(candidate, timeZone);
    const matches =
      p.year === y && p.month === m && p.day === d && p.hour === hour && p.minute === minute;
    if (matches) valid.push(candidate);
  }
  return valid.sort((a, b) => a.getTime() - b.getTime());
}

/**
 * The instant at which `timeZone`'s offset changes, somewhere in `(low, high)`.
 *
 * Used only for a window boundary that falls inside a spring-forward gap: the requested local time
 * never happens, and the honest answer for both a start and an end is the moment the clocks
 * jumped. A start then begins when time resumes; an end stops when time vanished. Neither invents
 * availability, and the gap contributes no slots — which is the rule Q3 states.
 *
 * Binary search to the second. Transitions land on whole minutes, so this terminates exactly.
 */
function transitionInstantBetween(low: Date, high: Date, timeZone: string): Date {
  const startOffset = offsetMinutesAt(low, timeZone);
  let lo = low.getTime();
  let hi = high.getTime();
  while (hi - lo > 1000) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if (offsetMinutesAt(new Date(mid), timeZone) === startOffset) lo = mid;
    else hi = mid;
  }
  return new Date(hi);
}

/**
 * Resolve one end of a working window to an instant.
 *
 * Ambiguous local times take the **earlier** instant for a start and the **later** for an end, so
 * a session spanning a fall-back covers all of the real time it actually spans — which on the
 * night Egypt's clocks go back is five hours of clinic for four hours of wall clock.
 */
export function resolveBoundary(
  date: string,
  minutesFromMidnight: number,
  timeZone: string,
  edge: "start" | "end",
): Date {
  const candidates = instantsForLocal(date, minutesFromMidnight, timeZone);
  if (candidates.length === 1) return candidates[0]!;
  if (candidates.length === 2) return edge === "start" ? candidates[0]! : candidates[1]!;

  const dayShift = Math.floor(minutesFromMidnight / 1440);
  const within = minutesFromMidnight - dayShift * 1440;
  const target = addDays(date, dayShift);
  const [y, m, d] = target.split("-").map(Number) as [number, number, number];
  const naive = Date.UTC(y, m - 1, d, Math.floor(within / 60), within % 60, 0);
  // The gap is bracketed by the two failed guesses; the transition lies strictly between them.
  const low = new Date(naive - 26 * 60 * 60_000);
  const high = new Date(naive + 26 * 60 * 60_000);
  return transitionInstantBetween(low, high, timeZone);
}
