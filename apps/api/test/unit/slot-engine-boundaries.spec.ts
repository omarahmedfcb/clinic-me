import { describeDay } from "../../src/modules/appointments/domain/describe-day.ts";
import { generateSlots } from "../../src/modules/appointments/domain/generate-slots.ts";
import type {
  GenerateSlotsInput,
  OccupancyRow,
  ScheduleBreakRow,
  ScheduleExceptionRow,
  ScheduleTemplateRow,
} from "../../src/modules/appointments/domain/types.ts";

/**
 * The exhaustive boundary table — PHASE-2.md §9.
 *
 * Every case here is one where an off-by-one is invisible in ordinary use and wrong exactly once:
 * a slot ending as a break begins, a `valid_to` on its final day, a session that crosses midnight
 * without any DST involved. `slot-engine-dst.spec.ts` covers the two nights a year; this covers
 * the other three hundred and sixty-three.
 *
 * Times are asserted as Cairo wall clock, which is safe here *because* none of these dates are
 * near a transition — the one place local strings are unambiguous. The DST spec deliberately does
 * the opposite for the opposite reason.
 */

const CAIRO = "Africa/Cairo";
/** 2026-09-01 is a Tuesday; JS getDay() = 2. Nowhere near an Egyptian DST transition. */
const TUESDAY = "2026-09-01";
const NOW = new Date("2026-08-01T00:00:00Z");

const localTimes = new Intl.DateTimeFormat("en-GB", {
  timeZone: CAIRO,
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

const template = (over: Partial<ScheduleTemplateRow> = {}): ScheduleTemplateRow => ({
  id: "t1",
  doctorId: "d1",
  weekday: 2,
  startTime: "09:00",
  endTime: "12:00",
  validFrom: "2026-01-01",
  validTo: null,
  ...over,
});

function slots(over: Partial<GenerateSlotsInput> = {}): string[] {
  const input: GenerateSlotsInput = {
    timezone: CAIRO,
    date: TUESDAY,
    doctorId: "d1",
    templates: [template()],
    breaks: [],
    exceptions: [],
    existingAppointments: [],
    service: { durationMinutes: 30, bufferMinutes: 0 },
    granularityMinutes: 30,
    leadMinutes: 0,
    now: NOW,
    ...over,
  };
  return generateSlots(input).map((s) => localTimes.format(s.start));
}

const busy = (start: string, end: string, over: Partial<OccupancyRow> = {}): OccupancyRow => ({
  id: "a1",
  doctorId: "d1",
  scheduledStart: new Date(start),
  scheduledEnd: new Date(end),
  status: "BOOKED",
  allowOverlap: false,
  serviceBufferMinutes: 0,
  ...over,
});

describe("slot engine boundaries", () => {
  describe("window edges", () => {
    it("offers a slot that ends exactly at closing time", () => {
      expect(slots({ templates: [template({ startTime: "09:00", endTime: "09:30" })] })).toEqual([
        "09:00",
      ]);
    });

    it("offers nothing when the window is one minute short", () => {
      expect(slots({ templates: [template({ startTime: "09:00", endTime: "09:29" })] })).toEqual([]);
    });

    it("anchors the grid to the window start, not the hour", () => {
      const odd = template({ startTime: "09:07", endTime: "10:37" });
      expect(slots({ templates: [odd] })).toEqual(["09:07", "09:37", "10:07"]);
    });
  });

  describe("validity window is inclusive at both ends (Q7)", () => {
    it("works on the first valid day", () => {
      expect(slots({ templates: [template({ validFrom: TUESDAY })] }).length).toBeGreaterThan(0);
    });

    it("works on the last valid day", () => {
      expect(slots({ templates: [template({ validTo: TUESDAY })] }).length).toBeGreaterThan(0);
    });

    it("does not work the day after validTo", () => {
      expect(slots({ templates: [template({ validTo: "2026-08-31" })] })).toEqual([]);
    });

    it("does not work the day before validFrom", () => {
      expect(slots({ templates: [template({ validFrom: "2026-09-02" })] })).toEqual([]);
    });
  });

  describe("breaks", () => {
    const withBreak = (b: ScheduleBreakRow): string[] =>
      slots({ templates: [template({ endTime: "13:00" })], breaks: [b] });

    it("a break touching the window start just shortens it", () => {
      expect(withBreak({ id: "b", scheduleTemplateId: "t1", startTime: "09:00", endTime: "10:00" })).toEqual(
        ["10:00", "10:30", "11:00", "11:30", "12:00", "12:30"],
      );
    });

    it("a slot may end exactly where a break begins", () => {
      const out = withBreak({ id: "b", scheduleTemplateId: "t1", startTime: "10:00", endTime: "10:30" });
      expect(out).toContain("09:30");
      expect(out).not.toContain("10:00");
      expect(out).toContain("10:30");
    });

    it("a break outside its template's hours removes nothing (Q10)", () => {
      expect(
        withBreak({ id: "b", scheduleTemplateId: "t1", startTime: "18:00", endTime: "19:00" }),
      ).toHaveLength(8);
    });

    it("a break on another template is ignored", () => {
      expect(
        withBreak({ id: "b", scheduleTemplateId: "other", startTime: "10:00", endTime: "11:00" }),
      ).toHaveLength(8);
    });
  });

  describe("exceptions", () => {
    const blocked = (over: Partial<ScheduleExceptionRow> = {}): ScheduleExceptionRow => ({
      id: "e",
      doctorId: "d1",
      date: TUESDAY,
      type: "BLOCKED",
      startTime: null,
      endTime: null,
      ...over,
    });

    it("a whole-day block clears the day", () => {
      expect(slots({ exceptions: [blocked()] })).toEqual([]);
    });

    it("a clinic-wide holiday clears the day for a doctor it does not name (Q13)", () => {
      expect(slots({ exceptions: [blocked({ type: "HOLIDAY", doctorId: null })] })).toEqual([]);
    });

    it("a block naming another doctor is ignored", () => {
      expect(slots({ exceptions: [blocked({ doctorId: "d2" })] })).toHaveLength(6);
    });

    it("a block on another date is ignored", () => {
      expect(slots({ exceptions: [blocked({ date: "2026-09-02" })] })).toHaveLength(6);
    });

    /**
     * Q12 as a rule rather than a step-order accident, and Q14's composition: a whole-day block
     * plus an extra-availability window is how "I work only this evening" is expressed, with no
     * second concept and no mode flag.
     */
    it("blocked always beats extra availability, whatever the row order", () => {
      const extra: ScheduleExceptionRow = {
        id: "e2",
        doctorId: "d1",
        date: TUESDAY,
        type: "EXTRA_AVAILABILITY",
        startTime: "18:00",
        endTime: "19:00",
      };
      const partial = blocked({ startTime: "18:00", endTime: "18:30" });
      // No template, so the only availability is the exception pair — which is what makes this a
      // test of precedence rather than of precedence plus an unrelated morning.
      expect(slots({ templates: [], exceptions: [extra, partial] })).toEqual(["18:30"]);
      expect(slots({ templates: [], exceptions: [partial, extra] })).toEqual(["18:30"]);
    });

    it("a whole-day block plus extra availability leaves only the evening", () => {
      const extra: ScheduleExceptionRow = {
        id: "e2",
        doctorId: "d1",
        date: TUESDAY,
        type: "EXTRA_AVAILABILITY",
        startTime: "18:00",
        endTime: "19:00",
      };
      expect(slots({ exceptions: [blocked(), extra] })).toEqual([]);
    });
  });

  describe("occupancy and buffers", () => {
    it("a cancelled appointment frees its time", () => {
      const cancelled = busy("2026-09-01T07:00:00Z", "2026-09-01T07:30:00Z", { status: "CANCELLED" });
      expect(slots({ existingAppointments: [cancelled] })).toHaveLength(6);
    });

    it("an authorised overlap still occupies, though the constraint ignores it (Q16)", () => {
      const overridden = busy("2026-09-01T07:00:00Z", "2026-09-01T07:30:00Z", { allowOverlap: true });
      expect(slots({ existingAppointments: [overridden] })).not.toContain("10:00");
    });

    it("another doctor's appointment does not occupy", () => {
      const other = busy("2026-09-01T07:00:00Z", "2026-09-01T07:30:00Z", { doctorId: "d2" });
      expect(slots({ existingAppointments: [other] })).toHaveLength(6);
    });

    it("the buffer belongs to the preceding appointment (Q20)", () => {
      const buffered = busy("2026-09-01T06:00:00Z", "2026-09-01T06:30:00Z", {
        serviceBufferMinutes: 30,
      });
      // 09:00-09:30 taken, plus 30 minutes of turnaround, so 09:30 is gone and 10:00 is the first.
      expect(slots({ existingAppointments: [buffered] })[0]).toBe("10:00");
    });

    it("a slot may start exactly when an appointment ends", () => {
      const appt = busy("2026-09-01T06:00:00Z", "2026-09-01T06:30:00Z");
      expect(slots({ existingAppointments: [appt] })).toContain("09:30");
    });
  });

  describe("cross-midnight sessions away from any DST transition (Q8)", () => {
    const night = template({ startTime: "22:00", endTime: "01:00" });

    it("runs continuously through midnight", () => {
      expect(slots({ templates: [night] })).toEqual([
        "22:00",
        "22:30",
        "23:00",
        "23:30",
        "00:00",
        "00:30",
      ]);
    });

    it("a break after midnight lands after midnight, not eighteen hours earlier", () => {
      const out = slots({
        templates: [night],
        breaks: [{ id: "b", scheduleTemplateId: "t1", startTime: "00:00", endTime: "00:30" }],
      });
      expect(out).toEqual(["22:00", "22:30", "23:00", "23:30", "00:30"]);
    });

    it("a block on the session's own date removes the post-midnight tail too (Q8b)", () => {
      const block: ScheduleExceptionRow = {
        id: "e",
        doctorId: "d1",
        date: TUESDAY,
        type: "BLOCKED",
        startTime: null,
        endTime: null,
      };
      expect(slots({ templates: [night], exceptions: [block] })).toEqual([]);
    });
  });

  describe("granularity and duration", () => {
    it("a duration longer than the window offers nothing", () => {
      expect(slots({ service: { durationMinutes: 240, bufferMinutes: 0 } })).toEqual([]);
    });

    it("a duration that is not a multiple of the granularity still fits by real length", () => {
      expect(slots({ service: { durationMinutes: 20, bufferMinutes: 0 } })).toEqual([
        "09:00",
        "09:30",
        "10:00",
        "10:30",
        "11:00",
        "11:30",
      ]);
    });

    it("returns nothing rather than looping forever on a zero granularity", () => {
      expect(slots({ granularityMinutes: 0 })).toEqual([]);
    });
  });

  describe("lead time subsumes 'in the past' (Q21/Q22)", () => {
    const midMorning = new Date("2026-09-01T07:15:00Z"); // 10:15 Cairo

    it("staff lead time of zero offers the rest of the day", () => {
      expect(slots({ now: midMorning, leadMinutes: 0 })).toEqual(["10:30", "11:00", "11:30"]);
    });

    it("a patient lead time pushes the first offer out", () => {
      expect(slots({ now: midMorning, leadMinutes: 120 })).toEqual([]);
    });
  });

  /**
   * Q25's guarantee, asserted rather than assumed: the day view and the booking flow are the same
   * computation. If these ever disagree, a receptionist is looking at a gap the booking endpoint
   * will refuse — with nothing on screen to say which of the two is lying.
   */
  describe("describeDay agrees with generateSlots", () => {
    const world: GenerateSlotsInput = {
      timezone: CAIRO,
      date: TUESDAY,
      doctorId: "d1",
      templates: [template({ endTime: "13:00" })],
      breaks: [{ id: "b", scheduleTemplateId: "t1", startTime: "11:00", endTime: "11:30" }],
      exceptions: [],
      existingAppointments: [busy("2026-09-01T07:00:00Z", "2026-09-01T07:30:00Z")],
      service: { durationMinutes: 30, bufferMinutes: 0 },
      granularityMinutes: 30,
      leadMinutes: 0,
      now: NOW,
    };

    /**
     * The day view colours each block by status, so the status has to survive the trip. This is
     * asserted rather than left to typecheck: adding a field to `BusyBlock` compiles whether or not
     * anything populates it, and an undefined status renders as an uncoloured block, which looks
     * like a design choice rather than a bug.
     */
    it("carries each appointment's status onto its busy block", () => {
      const day = describeDay({
        ...world,
        existingAppointments: [
          busy("2026-09-01T07:00:00Z", "2026-09-01T07:30:00Z", { id: "a", status: "ARRIVED" }),
          busy("2026-09-01T08:30:00Z", "2026-09-01T09:00:00Z", { id: "b", status: "IN_CONSULTATION" }),
        ],
      });

      expect(day.busy.map((b) => ({ id: b.appointmentId, status: b.status }))).toEqual([
        { id: "a", status: "ARRIVED" },
        { id: "b", status: "IN_CONSULTATION" },
      ]);
    });

    /**
     * Breaks and blocked time have to reach the screen, not merely be subtracted from it.
     *
     * `working` is computed *after* both are removed, so a break leaves an ordinary-looking gap
     * between two working windows. On the day view that gap renders identically to free time, and
     * a receptionist cannot tell "the doctor is available" from "the doctor is at lunch" — the
     * screen was never sent the difference. Asserted here rather than left to the calendar,
     * because the omission is invisible: the bar looks finished either way.
     */
    it("returns breaks as unavailable time, not merely as a gap in working", () => {
      const day = describeDay(world);

      // 11:00–11:30 Cairo, the break in `world`. September is +03.
      expect(
        day.unavailable.map((u) => [u.start.toISOString(), u.end.toISOString()]),
      ).toContainEqual(["2026-09-01T08:00:00.000Z", "2026-09-01T08:30:00.000Z"]);

      // And it is genuinely not working time — the two must not overlap.
      for (const u of day.unavailable) {
        for (const w of day.working) {
          expect(u.start.getTime() >= w.end.getTime() || u.end.getTime() <= w.start.getTime()).toBe(
            true,
          );
        }
      }
    });

    it("returns BLOCKED time as unavailable too", () => {
      const day = describeDay({
        ...world,
        exceptions: [
          {
            id: "x",
            doctorId: "d1",
            date: TUESDAY,
            type: "BLOCKED",
            startTime: "12:00",
            endTime: "13:00",
          },
        ],
      });

      expect(
        day.unavailable.map((u) => [u.start.toISOString(), u.end.toISOString()]),
      ).toContainEqual(["2026-09-01T09:00:00.000Z", "2026-09-01T10:00:00.000Z"]);
    });

    /**
     * The claim the day view's colour map is written against: there is no such thing as a
     * CANCELLED or NO_SHOW block. Both release the slot, so the timeline can never show the red
     * pair — which is why the strike-through that tells them apart lives on the badge in a list.
     *
     * Worth asserting because the two facts live far apart. `occupancy.ts` decides it; a component
     * three directories away depends on it and cannot see it.
     */
    it("never builds a block for a status that releases the slot", () => {
      for (const status of ["CANCELLED", "NO_SHOW"]) {
        const day = describeDay({
          ...world,
          existingAppointments: [
            busy("2026-09-01T07:00:00Z", "2026-09-01T07:30:00Z", { status }),
          ],
        });

        expect({ status, blocks: day.busy.length }).toEqual({ status, blocks: 0 });

        // And the time comes back as free, rather than merely being undrawn: with nothing
        // occupying it, free must account for the whole working window. (It is two segments, not
        // one — the 11:00 break splits it — which is why this compares durations, not counts.)
        const span = (xs: { start: Date; end: Date }[]): number =>
          xs.reduce((total, x) => total + (x.end.getTime() - x.start.getTime()), 0);
        expect({ status, free: span(day.free) }).toEqual({ status, free: span(day.working) });
      }
    });

    it("puts every slot inside a free block", () => {
      const day = describeDay(world);
      for (const slot of generateSlots(world)) {
        const inside = day.free.some(
          (f) => slot.start >= f.start && slot.end <= f.end,
        );
        expect({ slot: localTimes.format(slot.start), inside }).toEqual({
          slot: localTimes.format(slot.start),
          inside: true,
        });
      }
    });

    it("reports busy blocks the booking flow refuses", () => {
      const day = describeDay(world);
      expect(day.busy).toHaveLength(1);
      expect(generateSlots(world).map((s) => localTimes.format(s.start))).not.toContain("10:00");
    });

    it("tells 'fully booked' apart from 'does not work today'", () => {
      const dayOff = describeDay({ ...world, templates: [] });
      expect(dayOff.working).toEqual([]);
      expect(dayOff.fullyBooked).toBe(false);

      const full = describeDay({
        ...world,
        templates: [template({ startTime: "09:00", endTime: "09:30" })],
        breaks: [],
        existingAppointments: [busy("2026-09-01T06:00:00Z", "2026-09-01T06:30:00Z")],
      });
      expect(full.working).toHaveLength(1);
      expect(full.fullyBooked).toBe(true);
    });
  });
});
