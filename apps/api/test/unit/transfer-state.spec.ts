import {
  APPOINTMENT_CLOSES_REQUEST,
  TRANSFER_ACCESS_WINDOW_DAYS,
  accessExpiresAt,
  appointmentClosesRequest,
  effectiveStatus,
  grantIsActive,
  transition,
} from "../../src/modules/transfers/domain/transfer-state.ts";
import type { AppointmentStatus, TransferStatus } from "../../src/generated/prisma/enums.ts";

/**
 * The transfer state machine and its access window, over the complete matrix.
 *
 * The expiry half is the one the founder singled out: *"gaining access is the easy half, and an
 * expiry nobody tested is an expiry that doesn't happen."* So the boundary is asserted from both
 * sides with nothing moving but the clock, which is possible only because the clock is a parameter.
 */

const DAY = 24 * 60 * 60 * 1000;
const DECIDED = new Date("2026-09-01T09:00:00Z");

const ALL_STATUSES: TransferStatus[] = ["PENDING", "ACCEPTED", "REJECTED", "LAPSED"];

describe("the transfer request state machine", () => {
  describe("from PENDING", () => {
    test.each([
      ["ACCEPT", "ACCEPTED"],
      ["REJECT", "REJECTED"],
      ["LAPSE", "LAPSED"],
    ] as const)("%s -> %s", (event, expected) => {
      const result = transition("PENDING", event);
      expect(result).toEqual({ ok: true, next: expected });
    });
  });

  /**
   * The complete refusal matrix rather than a sample. Every non-PENDING state is terminal,
   * `LAPSED` included -- D24: a new occasion is a new request, because re-opening would make the
   * audit trail claim a decision was pending when nobody could have answered it.
   */
  describe("every non-PENDING state is terminal", () => {
    const terminal = ALL_STATUSES.filter((s) => s !== "PENDING");
    const events = ["ACCEPT", "REJECT", "LAPSE"] as const;

    for (const status of terminal) {
      for (const event of events) {
        test(`${status} refuses ${event}`, () => {
          const result = transition(status, event);
          expect(result.ok).toBe(false);
        });
      }
    }

    test("one code for every settled request, with `status` carrying which", () => {
      // Ruled 2026-09-07: `NO_LONGER_OPEN` folded into `ALREADY_DECIDED`. The distinction did not
      // go anywhere -- it moved from the code to the param, which already carried it on both
      // branches before the merge.
      //
      // A person who tries to accept a request that lapsed still needs to be told the appointment
      // ended, not that "someone already answered" -- nobody answered, which is the whole problem.
      // That sentence now comes from `params.status`, so this asserts the param, not just the code:
      // a merge that dropped `status` would leave the code meaning only "too late" for all three.
      expect(transition("LAPSED", "ACCEPT")).toMatchObject({
        code: "ALREADY_DECIDED",
        params: { status: "LAPSED" },
      });
      expect(transition("REJECTED", "ACCEPT")).toMatchObject({
        code: "ALREADY_DECIDED",
        params: { status: "REJECTED" },
      });
      expect(transition("ACCEPTED", "REJECT")).toMatchObject({
        code: "ALREADY_DECIDED",
        params: { status: "ACCEPTED" },
      });
    });

    test("the three statuses produce three different sentences, not one", () => {
      // The guard on the merge itself. Folding two codes into one is only safe while the param
      // distinguishes them; if `status` were ever dropped or hard-coded, every settled request
      // would read identically and this fails.
      const settled = ["ACCEPTED", "REJECTED", "LAPSED"] as const;
      const params = settled.map((status) => {
        const result = transition(status, "ACCEPT");
        expect(result.ok).toBe(false);
        return result.ok ? null : result.params["status"];
      });
      expect(new Set(params).size).toBe(3);
    });
  });
});

describe("which appointment statuses close an open request", () => {
  test.each(APPOINTMENT_CLOSES_REQUEST)("%s closes it", (status) => {
    expect(appointmentClosesRequest(status)).toBe(true);
  });

  test.each(["BOOKED", "CONFIRMED", "ARRIVED", "WAITING", "IN_CONSULTATION"] as AppointmentStatus[])(
    "%s leaves it open",
    (status) => {
      expect(appointmentClosesRequest(status)).toBe(false);
    },
  );
});

describe("the access window", () => {
  test("expires exactly the window after the decision", () => {
    expect(accessExpiresAt(DECIDED).toISOString()).toBe(
      new Date(DECIDED.getTime() + TRANSFER_ACCESS_WINDOW_DAYS * DAY).toISOString(),
    );
  });

  const accepted = { status: "ACCEPTED" as const, decidedAt: DECIDED, appointmentStatus: "COMPLETED" as const };

  /**
   * The boundary, from both sides, with **only the clock moving**. This is the assertion the
   * founder asked for -- the negative one. A grant that switches on is visible; a grant that never
   * switches off looks identical to a working one until somebody reads a record they should not.
   */
  test("is active one millisecond before the deadline", () => {
    const justBefore = new Date(accessExpiresAt(DECIDED).getTime() - 1);
    expect(grantIsActive(accepted, justBefore)).toBe(true);
  });

  test("is NOT active at the deadline", () => {
    expect(grantIsActive(accepted, accessExpiresAt(DECIDED))).toBe(false);
  });

  test("is NOT active a day after the deadline", () => {
    const after = new Date(accessExpiresAt(DECIDED).getTime() + DAY);
    expect(grantIsActive(accepted, after)).toBe(false);
  });

  test.each(["PENDING", "REJECTED", "LAPSED"] as TransferStatus[])(
    "a %s request grants nothing, however recent",
    (status) => {
      const decidedAt = status === "PENDING" ? null : DECIDED;
      expect(grantIsActive({ status, decidedAt, appointmentStatus: "COMPLETED" }, DECIDED)).toBe(false);
    },
  );

  test("an ACCEPTED row with no decidedAt grants nothing", () => {
    // The database CHECK makes this shape impossible; the guard stays because `now < null` is
    // false for the wrong reason and would be indistinguishable from a legitimately expired grant.
    expect(grantIsActive({ status: "ACCEPTED", decidedAt: null, appointmentStatus: "COMPLETED" }, DECIDED)).toBe(
      false,
    );
  });

  /**
   * The window deliberately outlives the appointment. Tying access to the visit would make the
   * window unreachable, since the appointment closes the same day -- and a thirty-day grant that
   * silently lasts one afternoon is a guarantee that reads as total and is not.
   */
  test("survives the appointment that produced it", () => {
    const nextWeek = new Date(DECIDED.getTime() + 7 * DAY);
    for (const appointmentStatus of APPOINTMENT_CLOSES_REQUEST) {
      expect(grantIsActive({ status: "ACCEPTED", decidedAt: DECIDED, appointmentStatus }, nextWeek)).toBe(true);
    }
  });
});

describe("effectiveStatus — a missed LAPSE write must not read as open", () => {
  test.each(APPOINTMENT_CLOSES_REQUEST)("a PENDING request on a %s appointment reads as LAPSED", (status) => {
    expect(effectiveStatus({ status: "PENDING", decidedAt: null, appointmentStatus: status })).toBe("LAPSED");
  });

  test("a PENDING request on a live appointment stays PENDING", () => {
    expect(effectiveStatus({ status: "PENDING", decidedAt: null, appointmentStatus: "ARRIVED" })).toBe("PENDING");
  });

  test("a decided request is never re-read as something else", () => {
    for (const status of ["ACCEPTED", "REJECTED", "LAPSED"] as TransferStatus[]) {
      expect(effectiveStatus({ status, decidedAt: DECIDED, appointmentStatus: "CANCELLED" })).toBe(status);
    }
  });
});
