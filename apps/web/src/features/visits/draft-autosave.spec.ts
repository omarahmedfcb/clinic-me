import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { resetSavers, saverFor, saveStateOf } from "./draft-autosave.ts";

/**
 * Two drafts open at once, and neither can spoil the other — `PHASE-4.md` Q17 and Q35.
 *
 * The assertion that carries this file is the third: **one draft's save fails and the other still
 * reports saved.** That is the guard the founder attached to Q35, and it is a property of where the
 * state lives. When the screen owned it, there was exactly one indicator, so the question could not
 * even be asked; a per-draft store is what makes the wrong answer expressible and therefore testable.
 */

const DRAFT_A = "visit-a";
const DRAFT_B = "visit-b";

function draftResponse(visitId: string, revision: number): Response {
  return new Response(
    JSON.stringify({
      id: visitId,
      appointmentId: `appt-${visitId}`,
      doctorId: "doctor-1",
      revision,
      complaint: null,
      medicalHistory: null,
      examination: null,
      diagnosis: null,
      treatmentPlan: null,
      doctorNotes: null,
      updatedAt: "2026-09-09T10:00:00.000Z",
      resumed: true,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

const succeeds = () => vi.fn(async () => draftResponse(DRAFT_A, 1));
const fails = () =>
  vi.fn(
    async () =>
      new Response(JSON.stringify({ code: "INTERNAL", params: {} }), {
        status: 500,
        headers: { "content-type": "application/json" },
      }),
  );

beforeEach(() => {
  resetSavers();
  window.localStorage.clear();
});

afterEach(() => {
  resetSavers();
});

describe("one autosaver per draft", () => {
  test("the same visit gets the same saver, and a different visit gets its own", () => {
    const context = { authFetch: succeeds(), appointmentId: "appt-a", delayMs: 5 };
    // Idempotent per draft, which is what makes a remount resume rather than start again.
    expect(saverFor(DRAFT_A, context)).toBe(saverFor(DRAFT_A, context));
    expect(saverFor(DRAFT_A, context)).not.toBe(saverFor(DRAFT_B, context));
  });

  test("a queued save survives the screen being replaced, which is what a tab switch is", async () => {
    const authFetch = succeeds();
    const saver = saverFor(DRAFT_A, { authFetch, appointmentId: "appt-a", delayMs: 5 });
    saver.queue({ diagnosis: "sinusitis" });
    expect(saveStateOf(DRAFT_A)?.kind).toBe("unsaved");

    // Nothing unmounts the timer, because nothing owns it but the saver. Q35: switching tabs must
    // neither flush the other draft nor block it.
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(saveStateOf(DRAFT_A)?.kind).toBe("saved");
    expect(authFetch).toHaveBeenCalledTimes(1);
  });

  test("one draft's save fails and the other still reports saved", async () => {
    const failing = fails();
    const working = succeeds();
    saverFor(DRAFT_A, { authFetch: failing, appointmentId: "appt-a", delayMs: 5 }).queue({
      diagnosis: "this one cannot reach the server",
    });
    saverFor(DRAFT_B, { authFetch: working, appointmentId: "appt-b", delayMs: 5 }).queue({
      diagnosis: "this one can",
    });

    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(saveStateOf(DRAFT_A)?.kind).toBe("failed");
    // The whole point. A shared indicator would have shown one word for two drafts, and the doctor
    // would have read the wrong one about the wrong patient.
    expect(saveStateOf(DRAFT_B)?.kind).toBe("saved");
  });

  test("a failed save keeps its text queued, and never claims it was saved", async () => {
    const failing = fails();
    const saver = saverFor(DRAFT_A, { authFetch: failing, appointmentId: "appt-a", delayMs: 5 });
    saver.queue({ diagnosis: "kept" });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(saveStateOf(DRAFT_A)?.kind).toBe("failed");

    // Retried against a server that works: the text is still there to send.
    saver.rebind({ authFetch: succeeds(), appointmentId: "appt-a", delayMs: 5 });
    await saver.flush();
    expect(saveStateOf(DRAFT_A)?.kind).toBe("saved");
  });

  test("a stale draft stays stale, because typing more will not fix it", async () => {
    const stale = vi.fn(
      async () =>
        new Response(JSON.stringify({ code: "STALE_REVISION", params: { revision: 9 } }), {
          status: 409,
          headers: { "content-type": "application/json" },
        }),
    );
    const saver = saverFor(DRAFT_A, { authFetch: stale, appointmentId: "appt-a", delayMs: 5 });
    saver.queue({ diagnosis: "x" });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(saveStateOf(DRAFT_A)?.kind).toBe("stale");

    // Saying "unsaved" here would suggest the doctor can type their way out of it. They cannot;
    // the action is to reload.
    saver.queue({ diagnosis: "xy" });
    expect(saveStateOf(DRAFT_A)?.kind).toBe("stale");
  });
});
