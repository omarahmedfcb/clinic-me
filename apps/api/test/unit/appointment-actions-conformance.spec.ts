import { legalSourcesFor, canReschedule as apiCanReschedule } from "../../src/modules/appointments/domain/transition.ts";
import {
  ALL_APPOINTMENT_STATUSES,
  CANCELLABLE_FROM,
  canCancel,
  canReschedule as webCanReschedule,
} from "../../../web/src/domain/appointment-status.ts";

/**
 * The screen's idea of which actions are legal must equal the state machine's.
 *
 * `apps/web` and `apps/api` are separate packages, so the web copy is a mirror rather than an
 * import. A mirror nobody compares is how `BOOKED` came to be a cream chip in one file and an
 * orange bar in another — both valid, neither checked against the other. The founder's wording for
 * the general form: **a guard that checks tokens exist cannot check that two files agree.**
 *
 * This is that missing comparison, for the rules rather than the colours. It is checked in **both
 * directions** across every status, so neither a status added to the web list nor one removed from
 * the edge table can pass: a one-directional subset check is the shape that misses exactly the
 * addition it exists to catch.
 */
describe("the panel's legal actions match the state machine", () => {
  it("compares something", () => {
    // Guards the guard: both assertions below are vacuous against an empty list.
    expect(ALL_APPOINTMENT_STATUSES.length).toBe(9);
    expect(CANCELLABLE_FROM.length).toBeGreaterThan(0);
  });

  it("agrees with the edge table on cancel, for every status in both directions", () => {
    const fromTable = legalSourcesFor("CANCEL");
    for (const status of ALL_APPOINTMENT_STATUSES) {
      expect([status, canCancel(status)]).toEqual([status, fromTable.includes(status)]);
    }
  });

  it("agrees with the domain on reschedule, for every status in both directions", () => {
    for (const status of ALL_APPOINTMENT_STATUSES) {
      expect([status, webCanReschedule(status)]).toEqual([status, apiCanReschedule(status)]);
    }
  });

  it("refuses the two the founder reported, and the terminal states", () => {
    for (const status of ["COMPLETED", "IN_CONSULTATION", "CANCELLED", "NO_SHOW"] as const) {
      expect([status, canCancel(status), webCanReschedule(status)]).toEqual([status, false, false]);
    }
  });
});
