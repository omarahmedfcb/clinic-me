import {
  ALL_EVENTS,
  ALL_STATUSES,
  transition,
  type AppointmentEvent,
  type AppointmentStatus,
} from "../../src/modules/appointments/domain/transition.ts";

/**
 * ARCHITECTURE.md §9: "tested exhaustively". Taken literally — every cell of
 * `AppointmentStatus × AppointmentEvent`, the illegal ones included, because a state machine's
 * value is entirely in what it refuses.
 *
 * The legal edges are written out again here rather than imported from the implementation. That
 * duplication is the test: a table compared against itself proves nothing, and importing `EDGES`
 * would mean a typo in the machine silently becomes the expectation.
 */

const SCHEDULED_START = new Date("2026-09-01T09:00:00Z");
const GRACE = 30;
const AFTER_GRACE = new Date("2026-09-01T09:31:00Z");
const BEFORE_GRACE = new Date("2026-09-01T09:29:00Z");

/** §9's diagram, transcribed by hand from the document. */
const LEGAL: ReadonlyArray<[AppointmentStatus, AppointmentEvent, AppointmentStatus]> = [
  ["BOOKED", "CONFIRM", "CONFIRMED"],
  ["BOOKED", "ARRIVE", "ARRIVED"],
  ["BOOKED", "CANCEL", "CANCELLED"],
  ["BOOKED", "MARK_NO_SHOW", "NO_SHOW"],
  ["CONFIRMED", "ARRIVE", "ARRIVED"],
  ["CONFIRMED", "CANCEL", "CANCELLED"],
  ["CONFIRMED", "MARK_NO_SHOW", "NO_SHOW"],
  ["ARRIVED", "MARK_WAITING", "WAITING"],
  ["ARRIVED", "CANCEL", "CANCELLED"],
  ["WAITING", "START_CONSULTATION", "IN_CONSULTATION"],
  ["WAITING", "CANCEL", "CANCELLED"],
  ["IN_CONSULTATION", "COMPLETE", "COMPLETED"],
  // Q34, ruled 2026-09-09. PAUSE and RESUME are a pair, and a paused visit can be ended without
  // resuming first — the patient came back, the doctor read the film and finished.
  ["IN_CONSULTATION", "PAUSE", "PAUSED"],
  ["PAUSED", "RESUME", "IN_CONSULTATION"],
  ["PAUSED", "COMPLETE", "COMPLETED"],
];

const isLegal = (from: AppointmentStatus, event: AppointmentEvent): AppointmentStatus | null =>
  LEGAL.find(([f, e]) => f === from && e === event)?.[2] ?? null;

/** Enough context that only the transition rules can be the reason for a refusal. */
const fullContext = {
  reason: "patient rang to cancel",
  now: AFTER_GRACE,
  scheduledStart: SCHEDULED_START,
  noShowGraceMinutes: GRACE,
};

describe("appointment state machine", () => {
  const cells = ALL_STATUSES.flatMap((status) =>
    ALL_EVENTS.map((event) => [status, event] as const),
  );

  it("covers every cell of the matrix", () => {
    // 9 statuses and 9 events since Q34 added PAUSED, PAUSE and RESUME. The number is the point:
    // it fails when a status or an event is added and this transcription is not extended.
    expect(cells).toHaveLength(9 * 9);
  });

  it.each(cells)("%s + %s", (status: AppointmentStatus, event: AppointmentEvent) => {
    const result = transition(status, event, fullContext);
    const expected = isLegal(status, event);

    if (expected === null) {
      expect(result.ok).toBe(false);
    } else {
      expect(result).toEqual({ ok: true, next: expected });
    }
  });

  /**
   * A terminal status gets its own refusal reason rather than the generic one. "That appointment
   * is already cancelled" and "you cannot do that from here" are different conversations, and the
   * AI agent has to say one of them to a patient.
   */
  it.each(["COMPLETED", "CANCELLED", "NO_SHOW"] as const)(
    "%s refuses everything as terminal, not as merely illegal",
    (terminal: AppointmentStatus) => {
      for (const event of ALL_EVENTS) {
        const result = transition(terminal, event, fullContext);
        expect(result).toMatchObject({ ok: false, code: "TERMINAL_STATUS", params: { status: terminal } });
      }
    },
  );

  describe("cancellation requires a reason (§9)", () => {
    it.each([undefined, null, "", "   "])("refuses reason=%p", (reason) => {
      expect(transition("BOOKED", "CANCEL", { ...fullContext, reason })).toMatchObject({
        ok: false,
        code: "REASON_REQUIRED",
      });
    });

    it("accepts a real reason", () => {
      expect(transition("BOOKED", "CANCEL", { ...fullContext, reason: "double booked" })).toEqual({
        ok: true,
        next: "CANCELLED",
      });
    });
  });

  /**
   * The grace period is decided inside the machine, not by the caller. §9 makes it part of
   * whether the transition is *legal*, so "when can this become NO_SHOW" is answerable by reading
   * one function — rather than by reading a function and also remembering that the nightly job
   * checks something first.
   */
  describe("no-show grace period", () => {
    it("refuses before the grace period has elapsed", () => {
      expect(
        transition("BOOKED", "MARK_NO_SHOW", { ...fullContext, now: BEFORE_GRACE }),
      ).toMatchObject({ ok: false, code: "GRACE_PERIOD_NOT_ELAPSED" });
    });

    it("allows once it has", () => {
      expect(transition("BOOKED", "MARK_NO_SHOW", { ...fullContext, now: AFTER_GRACE })).toEqual({
        ok: true,
        next: "NO_SHOW",
      });
    });

    it("treats the boundary instant as elapsed", () => {
      const exactly = new Date(SCHEDULED_START.getTime() + GRACE * 60_000);
      expect(transition("BOOKED", "MARK_NO_SHOW", { ...fullContext, now: exactly })).toEqual({
        ok: true,
        next: "NO_SHOW",
      });
    });

    it("honours a tenant's own grace period rather than a hardcoded 30", () => {
      const context = { ...fullContext, noShowGraceMinutes: 90, now: AFTER_GRACE };
      expect(transition("BOOKED", "MARK_NO_SHOW", context)).toMatchObject({
        ok: false,
        code: "GRACE_PERIOD_NOT_ELAPSED",
        // The tenant's own grace, echoed back: the value that decided the refusal.
        params: { limit: 90 },
      });
    });

    /**
     * Missing context is refused rather than defaulted. A default grace period here would be a
     * second place the clinic's setting lives, and the one that silently wins when a caller
     * forgets to pass it.
     */
    it("refuses rather than guessing when context is absent", () => {
      expect(transition("BOOKED", "MARK_NO_SHOW", { reason: "x" })).toMatchObject({
        ok: false,
        code: "MISSING_CONTEXT",
      });
    });

    it("does not read the clock", () => {
      const far = { ...fullContext, now: new Date("2099-01-01T00:00:00Z") };
      expect(transition("CONFIRMED", "MARK_NO_SHOW", far)).toEqual({ ok: true, next: "NO_SHOW" });
    });
  });

  /**
   * §9: "Reschedule is not a status." It mutates the times and appends an event row, so there is
   * deliberately no RESCHEDULE event. Asserted so that adding one is a decision rather than a
   * convenience someone reaches for while wiring the endpoint.
   */
  it("has no reschedule event", () => {
    expect(ALL_EVENTS).not.toContain("RESCHEDULE");
  });
});
