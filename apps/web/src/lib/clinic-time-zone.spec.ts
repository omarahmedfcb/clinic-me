// Pins what each zone means for a reader: a known instant must read as Egyptian wall time.
// December, so Egypt's summer clock does not decide the answer. One test per constant.

import { describe, expect, test } from "vitest";
import { DISPLAY_TIME_ZONE, NEW_CLINIC_TIME_ZONE } from "./clinic-time-zone.ts";

const wallClock = (timeZone: string): string =>
  new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hour12: false }).format(
    new Date("2026-12-01T07:00:00Z"),
  );

describe("the clinic time zones", () => {
  test("times are displayed in Egypt's zone: 07:00 UTC on 1 December 2026 reads 09:00", () => {
    expect(wallClock(DISPLAY_TIME_ZONE)).toBe("09:00");
  });

  test("a new clinic is proposed Egypt's zone: the same instant reads 09:00 there too", () => {
    expect(wallClock(NEW_CLINIC_TIME_ZONE)).toBe("09:00");
  });
});
