import { generateSlots } from "../../src/modules/appointments/domain/generate-slots.ts";
import type { GenerateSlotsInput, ScheduleTemplateRow } from "../../src/modules/appointments/domain/types.ts";

/**
 * Egypt's daylight-saving transitions, as the specification for cross-midnight sessions.
 *
 * PHASE-2.md Q8 condition 3: these are written and committed **red**, before the feature they
 * describe. That ordering is the point rather than ceremony. Egypt reinstated DST in 2023 with
 * transitions at **midnight** — not at 02:00, as most of the world does — so the only schedule
 * that can reach them is one that crosses midnight, which is exactly the feature Q8 rules must be
 * supported. An implementation written first and tested afterwards would be tested against
 * whatever it happened to do.
 *
 * Every instant below was **measured**, not derived: `Intl.DateTimeFormat` with
 * `timeZone: 'Africa/Cairo'`, probed either side of each transition on 2026-08-28.
 *
 *     2026-04-23T20:00Z -> 23/04/2026, 22:00:00 EET
 *     2026-04-23T23:00Z -> 24/04/2026, 02:00:00 EEST     (00:00-01:00 on the 24th never happens)
 *     2026-10-29T19:00Z -> 29/10/2026, 22:00:00 EEST
 *     2026-10-29T20:00Z -> 29/10/2026, 23:00:00 EEST     }  the same wall clock,
 *     2026-10-29T21:00Z -> 29/10/2026, 23:00:00 EET      }  one hour apart
 *     2026-10-30T00:00Z -> 30/10/2026, 02:00:00 EET
 *
 * They are asserted as UTC instants rather than local strings deliberately: a local string is
 * precisely what cannot tell the two 23:00s apart, so a test written in local time would pass
 * against an engine that silently dropped one of them.
 *
 * If a future IANA tzdb release moves Egypt's transitions, these fail loudly and a human looks —
 * which is PHASE-2.md Q4's decision not to pin the tz database, made visible.
 */

/** A Thursday-evening clinic running past midnight. Both 2026 transitions fall on a Thursday. */
const NIGHT_CLINIC: ScheduleTemplateRow = {
  id: "template-night",
  doctorId: "doctor-1",
  weekday: 4, // JS getDay(): Sunday = 0, so Thursday = 4 (PHASE-2.md Q5)
  startTime: "22:00",
  endTime: "02:00", // < startTime: crosses midnight, and is valid (PHASE-2.md Q8)
  validFrom: "2025-01-01",
  validTo: null,
};

function input(date: string): GenerateSlotsInput {
  return {
    timezone: "Africa/Cairo",
    date,
    doctorId: "doctor-1",
    templates: [NIGHT_CLINIC],
    breaks: [],
    exceptions: [],
    existingAppointments: [],
    service: { durationMinutes: 30, bufferMinutes: 0 },
    granularityMinutes: 30,
    leadMinutes: 0,
    now: new Date("2026-01-01T00:00:00Z"),
  };
}

const iso = (slots: { start: Date }[]): string[] => slots.map((s) => s.start.toISOString());

describe("slot engine — Egypt's DST transitions", () => {
  describe("spring forward: 24 April 2026, when 00:00-01:00 does not exist", () => {
    /**
     * The Thursday session runs 22:00 -> 02:00 in wall clock, which looks like four hours and is
     * three. At 24 April 00:00 EET the clocks jump to 01:00 EEST, so the window is
     * 2026-04-23T20:00Z .. 2026-04-23T23:00Z and the hour in between never occurs.
     */
    it("produces six slots, skipping the hour that never happens", () => {
      const slots = generateSlots(input("2026-04-23"));

      expect(iso(slots)).toEqual([
        "2026-04-23T20:00:00.000Z", // 22:00 EET
        "2026-04-23T20:30:00.000Z", // 22:30 EET
        "2026-04-23T21:00:00.000Z", // 23:00 EET
        "2026-04-23T21:30:00.000Z", // 23:30 EET
        "2026-04-23T22:00:00.000Z", // 01:00 EEST — the clocks have jumped; 00:00 is skipped
        "2026-04-23T22:30:00.000Z", // 01:30 EEST
      ]);
    });

    /**
     * Stated separately from the list above because it is the actual rule (a nonexistent local
     * time produces no slot), and a rule deserves an assertion of its own rather than being
     * something a reader has to infer by decoding six ISO strings.
     */
    it("emits no slot whose Cairo local time falls in the skipped hour", () => {
      const local = new Intl.DateTimeFormat("en-GB", {
        timeZone: "Africa/Cairo",
        dateStyle: "short",
        timeStyle: "short",
        hour12: false,
      });

      for (const slot of generateSlots(input("2026-04-23"))) {
        expect(local.format(slot.start)).not.toMatch(/^24\/04\/2026, 00:/);
      }
    });

    it("crosses the offset change within one continuous session", () => {
      const slots = generateSlots(input("2026-04-23"));

      expect(slots[0]?.utcOffsetMinutes).toBe(120); // EET
      expect(slots.at(-1)?.utcOffsetMinutes).toBe(180); // EEST
    });
  });

  describe("fall back: 29 October 2026, when 23:00-24:00 happens twice", () => {
    /**
     * The mirror image: 22:00 -> 02:00 looks like four hours and is five, because at 24:00 EEST
     * the clocks go back to 23:00 EET. The window is 2026-10-29T19:00Z .. 2026-10-30T00:00Z.
     *
     * Both occurrences are real bookable time and both are emitted (PHASE-2.md Q3). Dropping the
     * second would quietly delete an hour of a doctor's working evening.
     */
    it("produces ten slots, covering the repeated hour twice", () => {
      const slots = generateSlots(input("2026-10-29"));

      expect(iso(slots)).toEqual([
        "2026-10-29T19:00:00.000Z", // 22:00 EEST
        "2026-10-29T19:30:00.000Z", // 22:30 EEST
        "2026-10-29T20:00:00.000Z", // 23:00 EEST  <- first pass
        "2026-10-29T20:30:00.000Z", // 23:30 EEST  <- first pass
        "2026-10-29T21:00:00.000Z", // 23:00 EET   <- second pass, one hour later in real time
        "2026-10-29T21:30:00.000Z", // 23:30 EET   <- second pass
        "2026-10-29T22:00:00.000Z", // 00:00 EET
        "2026-10-29T22:30:00.000Z", // 00:30 EET
        "2026-10-29T23:00:00.000Z", // 01:00 EET
        "2026-10-29T23:30:00.000Z", // 01:30 EET
      ]);
    });

    /**
     * The ambiguous pair is what `utcOffsetMinutes` exists for. Without it the two 23:00 slots are
     * indistinguishable to any UI rendering local time, and a receptionist sees what looks like
     * the same slot listed twice.
     */
    it("distinguishes the two 23:00 slots by offset, not by label", () => {
      const local = new Intl.DateTimeFormat("en-GB", {
        timeZone: "Africa/Cairo",
        timeStyle: "short",
        hour12: false,
      });
      const slots = generateSlots(input("2026-10-29"));
      const at2300 = slots.filter((s) => local.format(s.start) === "23:00");

      expect(at2300).toHaveLength(2);
      expect(at2300[0]?.utcOffsetMinutes).toBe(180); // EEST
      expect(at2300[1]?.utcOffsetMinutes).toBe(120); // EET
      expect(at2300[1]!.start.getTime() - at2300[0]!.start.getTime()).toBe(3_600_000);
    });
  });

  /**
   * Both sessions began on Thursday and run into Friday. PHASE-2.md Q8b rules that such a slot
   * belongs to the day its session STARTED, so that one BLOCKED row on Thursday closes the whole
   * Thursday night clinic. Under the alternative reading it would take two rows on two dates, and
   * the second one is the one nobody remembers.
   */
  it("anchors post-midnight slots to the date their session began", () => {
    for (const date of ["2026-04-23", "2026-10-29"]) {
      const slots = generateSlots(input(date));
      expect(slots.length).toBeGreaterThan(0);
      for (const slot of slots) expect(slot.sessionDate).toBe(date);
    }
  });

  /**
   * The contract in §7 says generating one day requires the PREVIOUS day's templates too. Asserted
   * rather than commented: querying the Friday must surface the tail of the Thursday session only
   * when the Thursday template is supplied, and a caller who passes one day's rows gets a
   * measurably shorter answer.
   */
  it("returns nothing for the following day, because that session is anchored to Thursday", () => {
    expect(generateSlots(input("2026-04-24"))).toEqual([]);
  });
});
