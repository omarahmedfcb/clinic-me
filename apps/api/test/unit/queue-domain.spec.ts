import {
  DEFAULT_QUEUE_ORDERING,
  orderQueue,
  type QueueOrderable,
} from "../../src/modules/queue/domain/ordering.ts";
import {
  graceReferenceInstant,
  isNoShowCandidate,
  noShowEligibleAt,
} from "../../src/modules/queue/domain/no-show.ts";
import { transition } from "../../src/modules/appointments/domain/transition.ts";

/**
 * The queue's pure decisions — `PHASE-3.md` Q3 and Q9.
 *
 * These import nothing under `src/prisma/`, which is what lets them run with no database and no
 * `.env` (`CLAUDE.md`: a unit spec that needs a database URL has an import-graph bug). Verified by
 * `npm run test:no-dotenv`, not by inspection.
 */

const at = (iso: string): Date => new Date(iso);

const row = (id: string, scheduled: string, arrived: string | null): QueueOrderable => ({
  appointmentId: id,
  scheduledStart: at(scheduled),
  arrivedAt: arrived === null ? null : at(arrived),
});

describe("queue ordering (Q3)", () => {
  test("the default is arrival order, and it is a decision that can be read", () => {
    // Named rather than inlined precisely so this assertion can exist: if someone switches the
    // default after the pilot, they change one constant and this line tells them they did.
    expect(DEFAULT_QUEUE_ORDERING).toBe("ARRIVAL");
  });

  /*
    One fixture, both rules, opposite answers — which is the honest way to show the ruling has
    teeth. "a" is booked at 10:00 but turned up at 09:30; "b" is booked at 09:45 and arrived at
    09:44. Arrival order seats "a" first because "a" has been sitting there longer; schedule order
    seats "b" first because the book says so. This is precisely the disagreement Q3 is open about.
  */
  const bookedLaterArrivedEarlier = row("a", "2026-09-01T10:00:00Z", "2026-09-01T09:30:00Z");
  const bookedEarlierArrivedLater = row("b", "2026-09-01T09:45:00Z", "2026-09-01T09:44:00Z");
  const contested = [bookedLaterArrivedEarlier, bookedEarlierArrivedLater];

  test("ARRIVAL: the waiting room's order — longest wait first", () => {
    expect(orderQueue(contested, "ARRIVAL").map((r) => r.appointmentId)).toEqual(["a", "b"]);
  });

  test("SCHEDULE: the appointment book's order — the same two rows, reversed", () => {
    expect(orderQueue(contested, "SCHEDULE").map((r) => r.appointmentId)).toEqual(["b", "a"]);
  });

  test("SCHEDULE really does differ from ARRIVAL where the two disagree", () => {
    const bookedFirstArrivedLast = row("a", "2026-09-01T09:00:00Z", "2026-09-01T09:50:00Z");
    const bookedLastArrivedFirst = row("b", "2026-09-01T11:00:00Z", "2026-09-01T08:00:00Z");
    const rows = [bookedFirstArrivedLast, bookedLastArrivedFirst];

    expect(orderQueue(rows, "ARRIVAL").map((r) => r.appointmentId)).toEqual(["b", "a"]);
    expect(orderQueue(rows, "SCHEDULE").map((r) => r.appointmentId)).toEqual(["a", "b"]);
  });

  test("someone who has not arrived sorts last — they are not in the room", () => {
    const waiting = row("a", "2026-09-01T11:00:00Z", "2026-09-01T10:00:00Z");
    const notYetHere = row("b", "2026-09-01T09:00:00Z", null);

    expect(orderQueue([notYetHere, waiting], "ARRIVAL").map((r) => r.appointmentId)).toEqual([
      "a",
      "b",
    ]);
  });

  test("the order is total, so two polls a second apart cannot disagree", () => {
    // Identical arrival AND identical scheduled time: without the id tiebreaker the result would
    // depend on input order, and the queue would visibly reshuffle between refreshes.
    const same = "2026-09-01T09:00:00Z";
    const x = row("x", same, same);
    const y = row("y", same, same);

    expect(orderQueue([x, y]).map((r) => r.appointmentId)).toEqual(["x", "y"]);
    expect(orderQueue([y, x]).map((r) => r.appointmentId)).toEqual(["x", "y"]);
  });

  test("does not mutate the caller's array", () => {
    const rows = [row("b", "2026-09-01T10:00:00Z", "2026-09-01T10:00:00Z"),
                  row("a", "2026-09-01T09:00:00Z", "2026-09-01T09:00:00Z")];
    const before = rows.map((r) => r.appointmentId);

    orderQueue(rows);

    expect(rows.map((r) => r.appointmentId)).toEqual(before);
  });
});

describe("no-show candidacy (Q9)", () => {
  const GRACE = 30;

  test("with the doctor on time, the reference is the appointment's start", () => {
    const scheduled = at("2026-09-01T09:00:00Z");
    expect(graceReferenceInstant(scheduled, null)).toEqual(scheduled);
  });

  test("a doctor running late moves the reference, not the appointment", () => {
    // The founder's case: booked 09:00, doctor freed up at 10:30. The patient is not absent at
    // 09:30 merely because the book said 09:00.
    const scheduled = at("2026-09-01T09:00:00Z");
    const freeAt = at("2026-09-01T10:30:00Z");

    expect(graceReferenceInstant(scheduled, freeAt)).toEqual(freeAt);
    expect(noShowEligibleAt({ scheduledStart: scheduled, doctorFreeAt: freeAt, graceMinutes: GRACE }))
      .toEqual(at("2026-09-01T11:00:00Z"));

    // Under the naive rule this patient was a candidate at 09:30. Under the ruled one they are not.
    expect(
      isNoShowCandidate({
        scheduledStart: scheduled,
        doctorFreeAt: freeAt,
        graceMinutes: GRACE,
        now: at("2026-09-01T09:30:00Z"),
      }),
    ).toBe(false);
  });

  test("a doctor running early does not shorten the patient's grace", () => {
    // Freed at 08:00 for a 09:00 appointment: the reference is still 09:00, not 08:00, or the
    // patient would be absent before their appointment had begun.
    const scheduled = at("2026-09-01T09:00:00Z");
    expect(graceReferenceInstant(scheduled, at("2026-09-01T08:00:00Z"))).toEqual(scheduled);
  });

  test("once the clinic really was ready and the grace elapsed, it is a candidate", () => {
    expect(
      isNoShowCandidate({
        scheduledStart: at("2026-09-01T09:00:00Z"),
        doctorFreeAt: at("2026-09-01T10:30:00Z"),
        graceMinutes: GRACE,
        now: at("2026-09-01T11:00:00Z"),
      }),
    ).toBe(true);
  });

  test("the boundary is inclusive, and one millisecond before it is not", () => {
    const base = {
      scheduledStart: at("2026-09-01T09:00:00Z"),
      doctorFreeAt: null,
      graceMinutes: GRACE,
    };
    const eligible = noShowEligibleAt(base);

    expect(isNoShowCandidate({ ...base, now: new Date(eligible.getTime() - 1) })).toBe(false);
    expect(isNoShowCandidate({ ...base, now: eligible })).toBe(true);
  });
});

describe("transition() honours the readiness reference (Q9)", () => {
  const scheduled = at("2026-09-01T09:00:00Z");
  const freeAt = at("2026-09-01T10:30:00Z");
  const context = { scheduledStart: scheduled, noShowGraceMinutes: 30 };

  test("without graceReference it behaves exactly as before", () => {
    // The whole point of making the field optional: every Phase 2 caller is untouched.
    expect(transition("BOOKED", "MARK_NO_SHOW", { ...context, now: at("2026-09-01T09:31:00Z") }))
      .toEqual({ ok: true, next: "NO_SHOW" });
  });

  test("with it, the same instant is refused because the clinic was not ready", () => {
    const result = transition("BOOKED", "MARK_NO_SHOW", {
      ...context,
      graceReference: freeAt,
      now: at("2026-09-01T09:31:00Z"),
    });

    // "Not yet" is useless without "until when", so the instant is still asserted -- as a param
    // rather than as a substring of a sentence, since the wire stopped carrying one on 2026-09-06.
    //
    // What is NOT asserted any more is which reference the grace ran from ("the doctor becoming
    // free"). That phrase was dropped deliberately: it has no consequence for the reader, who gets
    // the same answer either way, and it was the only part of the old sentence that named an
    // internal rule rather than a fact.
    expect(result).toMatchObject({
      ok: false,
      code: "GRACE_PERIOD_NOT_ELAPSED",
      params: { at: "2026-09-01T11:00:00.000Z" },
    });
  });

  test("and allowed once the readiness grace has elapsed", () => {
    expect(
      transition("BOOKED", "MARK_NO_SHOW", {
        ...context,
        graceReference: freeAt,
        now: at("2026-09-01T11:00:00Z"),
      }),
    ).toEqual({ ok: true, next: "NO_SHOW" });
  });
});
