import { driverCause } from "../../src/prisma/driver-error.ts";
import { isDeadlock } from "../../src/prisma/deadlock-retry.ts";
import {
  DEADLOCK_7_10_0,
  DEADLOCK_7_9_1,
  SLOT_TAKEN_7_9_1,
} from "./prisma-error-shapes.ts";

/**
 * **Both Prisma error shapes, so a version bump cannot silently disarm the booking retry.**
 *
 * On 2026-09-19 Dependabot proposed Prisma 7.9.1 → 7.10.0. The bump renamed `cause.code` to
 * `cause.originalCode` for a transaction conflict; `isDeadlock` read `cause.code`, returned `false`
 * for a real deadlock, and every booking deadlock stopped being retried. Nothing in this directory
 * noticed — the old unit fixture was hand-built from the shape that existed at the time, so it
 * agreed with the code it was testing. `booking-deadlock.integration.spec.ts` caught it, because it
 * raises the error out of Postgres instead of writing it down.
 *
 * That reproducer stays the guard. This file is the cheaper half of the same job: the two shapes
 * captured verbatim from it, one per version, asserted against the classifier that reads them. A
 * third shape gets added here the next time Prisma moves one — and the integration spec is what
 * will tell us it has.
 */
describe("driverCause reads the SQLSTATE whichever field Prisma put it in", () => {
  test("7.9.1: the spelling that existed when isDeadlock was written", () => {
    expect(driverCause(DEADLOCK_7_9_1)).toEqual({
      code: "40P01",
      message: "deadlock detected",
    });
  });

  test("7.10.0: the spelling that broke it, with `code` gone entirely", () => {
    // The whole defect in one assertion. `DEADLOCK_7_10_0.meta.driverAdapterError.cause.code` is
    // `undefined`, so the previous classifier compared `undefined === "40P01"` and said no.
    expect(DEADLOCK_7_10_0.meta.driverAdapterError.cause).not.toHaveProperty("code");
    expect(driverCause(DEADLOCK_7_10_0)).toEqual({
      code: "40P01",
      message: "deadlock detected",
    });
  });

  test("an exclusion violation keeps its full shape on both versions", () => {
    expect(driverCause(SLOT_TAKEN_7_9_1)).toEqual({
      code: "23P01",
      message: 'conflicting key value violates exclusion constraint "no_double_booking"',
    });
  });

  test("nothing is invented for an error that carries no driver cause", () => {
    expect(driverCause(new Error("plain"))).toEqual({});
    expect(driverCause({ code: "P2039" })).toEqual({});
    expect(driverCause({ meta: { driverAdapterError: {} } })).toEqual({});
    expect(driverCause(null)).toEqual({});
    expect(driverCause(undefined)).toEqual({});
  });

  test("a non-string code is not passed off as one", () => {
    // Defensive rather than observed: `toEqual` would treat a numeric 40801 as absent anyway, and
    // the point is that a classifier never compares a string constant against something else.
    expect(driverCause({ meta: { driverAdapterError: { cause: { originalCode: 40_801 } } } })).toEqual({});
  });
});

describe("isDeadlock holds across the version boundary", () => {
  test("both captured deadlocks are recognised", () => {
    expect(isDeadlock(DEADLOCK_7_9_1)).toBe(true);
    expect(isDeadlock(DEADLOCK_7_10_0)).toBe(true);
  });

  test("the exclusion violation is still not a deadlock on either", () => {
    // The half that matters more: if this were true, every lost race would be retried three times
    // and then reported as CONTENDED, turning the correct SLOT_TAKEN answer into a confusing one.
    expect(isDeadlock(SLOT_TAKEN_7_9_1)).toBe(false);
    expect(
      isDeadlock({
        meta: { driverAdapterError: { cause: { originalCode: "23P01", kind: "postgres" } } },
      }),
    ).toBe(false);
  });
});
