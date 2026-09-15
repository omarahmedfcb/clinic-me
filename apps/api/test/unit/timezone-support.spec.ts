import { assertTimezoneDataAvailable } from "../../src/common/timezone-support.ts";

/**
 * The boot guard from PHASE-2.md's Definition of Done: "Boot fails if `Africa/Cairo` resolves to
 * UTC".
 *
 * A Node build without full ICU does not throw on an unknown zone — it silently returns UTC. Every
 * appointment in Egypt would be an hour or two off, uniformly, with no error anywhere. The whole
 * point of the guard is that this failure is otherwise invisible, so the guard itself must be
 * shown to fire rather than assumed to.
 *
 * The runtime cannot be stripped of ICU inside a test, so the two failure branches are exercised
 * by substituting an `Intl.DateTimeFormat` that behaves the way a crippled runtime does. That is
 * the honest limit of what a unit test can reach here, and it is stated rather than papered over:
 * this proves the *predicate* is right, not that a small-icu Node would be caught — for that,
 * `docs/DEPLOY.md`'s container is the real check, and it runs the same code at boot.
 */
describe("timezone data assertion", () => {
  const RealDateTimeFormat = Intl.DateTimeFormat;

  afterEach(() => {
    (Intl as { DateTimeFormat: typeof Intl.DateTimeFormat }).DateTimeFormat = RealDateTimeFormat;
  });

  /** Replaces Intl with one that reports a fixed offset for every instant, as small-icu does. */
  function pretendOffset(minutesAheadOfUtc: number): void {
    (Intl as { DateTimeFormat: unknown }).DateTimeFormat = function FakeFormat(
      _locale?: string,
      _options?: Intl.DateTimeFormatOptions,
    ) {
      return {
        formatToParts(instant: Date) {
          const shifted = new Date(instant.getTime() + minutesAheadOfUtc * 60_000);
          const pad = (n: number): string => String(n).padStart(2, "0");
          return [
            { type: "year", value: String(shifted.getUTCFullYear()) },
            { type: "month", value: pad(shifted.getUTCMonth() + 1) },
            { type: "day", value: pad(shifted.getUTCDate()) },
            { type: "hour", value: pad(shifted.getUTCHours()) },
            { type: "minute", value: pad(shifted.getUTCMinutes()) },
            { type: "second", value: pad(shifted.getUTCSeconds()) },
          ];
        },
      };
    } as unknown as typeof Intl.DateTimeFormat;
  }

  it("passes on this runtime, which has real timezone data", () => {
    expect(() => assertTimezoneDataAvailable()).not.toThrow();
  });

  it("throws when the zone silently resolves to UTC", () => {
    pretendOffset(0);
    expect(() => assertTimezoneDataAvailable()).toThrow(/resolves .* to UTC|no IANA timezone data/);
  });

  /**
   * The second branch matters on its own: a runtime returning a fixed +02:00 all year would pass a
   * naive "is it UTC?" check while having no DST rules — and Egypt's DST transitions fall at
   * midnight, exactly where this system's cross-midnight sessions run.
   */
  it("throws when the offset never changes across the year", () => {
    pretendOffset(120);
    expect(() => assertTimezoneDataAvailable()).toThrow(/not applying daylight-saving rules/);
  });

  it("reports the real Cairo offsets on this runtime", () => {
    const format = (iso: string): string =>
      new Intl.DateTimeFormat("en-GB", {
        timeZone: "Africa/Cairo",
        timeZoneName: "short",
      }).format(new Date(iso));

    // Measured against this runtime, not recalled: it names the zones rather than printing
    // numeric offsets, so EET in January and EEST in July. Asserting "GMT+2" here failed, which
    // is the small reason to run a test like this rather than reason about what Intl returns.
    expect(format("2026-01-15T12:00:00Z")).toContain("EET");
    expect(format("2026-07-15T12:00:00Z")).toContain("EEST");
  });
});
