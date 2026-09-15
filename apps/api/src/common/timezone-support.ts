/**
 * Boot-time proof that this runtime can actually resolve IANA timezones.
 *
 * The slot engine converts wall clock to instants through `Intl.DateTimeFormat` with the tenant's
 * zone. **A Node build without full ICU does not fail on an unknown zone — it silently resolves
 * it to UTC.** Every appointment in Egypt would then be booked one or two hours off, uniformly,
 * with no error anywhere: the API answers, the slots look plausible, the times are wrong, and the
 * first person to notice is a patient arriving an hour late.
 *
 * That is the exact failure shape this project keeps meeting — something that appears to work.
 * So it is checked once, loudly, at startup rather than trusted.
 *
 * Node has shipped full ICU by default since v13, so this should never fire. It costs microseconds
 * and it converts a silent, uniform, hard-to-diagnose data error into a container that refuses to
 * start with a message naming the cause. `--with-intl=small-icu` builds, some Alpine variants, and
 * a `NODE_ICU_DATA` pointed at nothing all reintroduce it.
 */

/** Two instants that differ in offset for Cairo: January is EET (+02), July is EEST (+03). */
const WINTER = new Date("2026-01-15T12:00:00Z");
const SUMMER = new Date("2026-07-15T12:00:00Z");

function offsetMinutes(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);

  const read = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((candidate) => candidate.type === type);
    if (part === undefined) throw new Error(`Intl returned no "${type}" part for "${timeZone}".`);
    return Number(part.value);
  };

  const asUtc = Date.UTC(
    read("year"),
    read("month") - 1,
    read("day"),
    read("hour") % 24,
    read("minute"),
    read("second"),
  );
  return (asUtc - instant.getTime()) / 60_000;
}

/**
 * Throws unless the runtime resolves a real IANA zone to a real offset.
 *
 * `Africa/Cairo` appears here and nowhere else in `src/` — this is the probe, not a default. The
 * slot engine takes its zone from `tenants.timezone` (CLAUDE.md), and the `domain/` source scan
 * fails the build if this string appears there.
 *
 * Two assertions, because either alone is passable by a broken runtime: a fixed non-zero offset
 * would satisfy "not UTC" while having no DST rules at all, and a zone that tracked DST but
 * resolved to UTC in winter would satisfy "summer differs from winter".
 */
export function assertTimezoneDataAvailable(): void {
  const probe = "Africa/Cairo";
  const winter = offsetMinutes(WINTER, probe);
  const summer = offsetMinutes(SUMMER, probe);

  if (winter === 0 && summer === 0) {
    throw new Error(
      `This Node runtime resolves "${probe}" to UTC, which means it has no IANA timezone data. ` +
        "Timezone-aware code does not fail on such a runtime -- it silently returns UTC, so every " +
        "appointment would be booked one or two hours off with no error anywhere. Run a Node " +
        "build with full ICU (the default since v13), or set NODE_ICU_DATA to a valid data file.",
    );
  }

  if (winter === summer) {
    throw new Error(
      `This Node runtime reports the same UTC offset for "${probe}" in January and July ` +
        `(${winter} minutes), so it is not applying daylight-saving rules. Egypt has observed DST ` +
        "since 2023 and its transitions fall at midnight, which is exactly when this system's " +
        "cross-midnight clinic sessions run. See PHASE-2.md Q3.",
    );
  }
}
