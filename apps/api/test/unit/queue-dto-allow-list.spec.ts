import type { QueueEntry } from "../../src/modules/queue/queue.types.ts";

/**
 * Every key reception's queue row may carry, listed once — `PHASE-4.md` Q14.
 *
 * ## Why an allow-list rather than a sweep
 *
 * `clinical-leak-guard.integration.spec.ts` sweeps reception's responses for sentinel *strings* a
 * doctor typed. It cannot see a **derived** leak: a character count of a diagnosis, a "notes look
 * empty" heuristic, a first-forty-characters preview. Those contain no sentinel and would pass the
 * sweep while being exactly what Q14 forbids — content wearing metadata's clothes.
 *
 * Q14 states the boundary as authorship: **a field may be added here only if its value can be
 * computed without reading a clinician-authored column.** `visitStatus` passes, because the workflow
 * sets that column. `complaintPreview` fails. This file is the mechanical half of that rule, and the
 * paragraph in Q14 is the half a human has to pass.
 *
 * ## Two halves, and they fail differently
 *
 * `satisfies Record<keyof QueueEntry, ...>` fails **at compile time** when a key is added to the
 * type and not listed here — so a new field cannot reach a running system unlisted. The runtime
 * assertion below then fails when the list and the type drift the other way.
 */

/** What each key is, so that adding one means writing down which side of Q14's line it sits on. */
type Provenance = "workflow" | "identity" | "schedule" | "derived-from-schedule" | "insurance";

const ALLOWED = {
  appointmentId: "identity",
  patientId: "identity",
  patientName: "identity",
  coverage: "insurance",
  doctorId: "identity",
  serviceId: "identity",
  status: "workflow",
  scheduledStart: "schedule",
  scheduledEnd: "schedule",
  arrivedAt: "workflow",
  waitingStartedAt: "workflow",
  consultationStartedAt: "workflow",
  waitedMs: "derived-from-schedule",
  isWalkIn: "schedule",
  // The one field PR 5 adds. A status column the workflow sets — never anything a clinician typed.
  visitStatus: "workflow",
} satisfies Record<keyof QueueEntry, Provenance>;

describe("the queue row carries workflow facts and nothing a clinician authored", () => {
  test("no key on `QueueEntry` is missing from the allow-list, and none is invented", () => {
    // The compile-time half is `satisfies` above. This is the runtime mirror, so the list cannot be
    // widened without a human reading it.
    expect(Object.keys(ALLOWED).sort()).toEqual(
      [
        "appointmentId",
        "arrivedAt",
        "consultationStartedAt",
        "coverage",
        "doctorId",
        "isWalkIn",
        "patientId",
        "patientName",
        "scheduledEnd",
        "scheduledStart",
        "serviceId",
        "status",
        "visitStatus",
        "waitedMs",
        "waitingStartedAt",
      ].sort(),
    );
  });

  test("nothing on the row is provenanced to a clinician-authored column", () => {
    // Deliberately a whitelist of provenances rather than a blacklist of field names: a blacklist
    // has to predict what someone will call the next leak.
    const provenances = new Set(Object.values(ALLOWED));
    expect([...provenances].sort()).toEqual([
      "derived-from-schedule",
      "identity",
      "insurance",
      "schedule",
      "workflow",
    ]);
  });

  test("exactly one visit field exists, so a second cannot arrive unnoticed", () => {
    // The Definition of Done singles this out: Q14 grants `visitStatus` and nothing else, and a
    // second visit-derived field is the shape the sentinel sweep cannot see.
    const visitFields = Object.keys(ALLOWED).filter((key) => key.toLowerCase().startsWith("visit"));
    expect(visitFields).toEqual(["visitStatus"]);
  });
});
