import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LocaleProvider } from "../../i18n/locale-context.tsx";
import { VisitDraftScreen } from "./VisitDraftScreen.tsx";
import { resetSavers } from "./draft-autosave.ts";
import { recall } from "./draft-store.ts";

/**
 * The indicator never claims "saved" when it has not saved — Q4.
 *
 * Driven through the real component rather than asserted on the state machine, because the failure
 * this guards is a rendering one: a screen that shows a reassuring word while text is only in the
 * browser. `web-password-toggle.spec.ts` established that a client behaviour is proven by driving it.
 */

const DRAFT = {
  id: "visit-1",
  appointmentId: "appt-1",
  revision: 0,
  complaint: null,
  medicalHistory: null,
  examination: null,
  diagnosis: null,
  treatmentPlan: null,
  doctorNotes: null,
  updatedAt: "2026-09-07T10:00:00.000Z",
  resumed: false,
};

const HEADER = {
  patientId: "patient-1",
  fullNameAr: "مريم حسن",
  fullNameEn: null,
  dateOfBirth: "1990-04-02",
  gender: "FEMALE",
  phoneE164: "+201000000000",
  allergies: [],
  allergiesReviewedAt: null,
  coverage: { standing: "NONE" as const },
  visitCount: 2,
  lastVisitAt: "2026-08-01T09:00:00.000Z",
};

const PROFILE = {
  patientId: "patient-1",
  entries: [],
  lastUpdatedAt: null,
  lastUpdatedBy: null,
  heightCm: null,
  firstVisit: false,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * The header, profile, orders and procedures panels each fetch on mount. Answering them here keeps
 * these tests about the autosave indicator, rather than about a panel's payload.
 */
function withPanels(
  // Named `inner`, not `authFetch`: `route-capability-manifest.spec.ts` scans for `authFetch(...)`
  // call sites and would report this delegate as a client calling a route that does not exist.
  inner: (path: string, init?: RequestInit) => Promise<Response>,
): (path: string, init?: RequestInit) => Promise<Response> {
  return async (path, init) => {
    if (path.includes("/visits/open")) return jsonResponse([]);
    if (path.includes("/clinical-summary")) return jsonResponse(HEADER);
    if (path.includes("/clinical-profile")) return jsonResponse(PROFILE);
    if (path.includes("/prescription")) {
      return jsonResponse({ prescriptionId: null, notes: null, items: [], printedCount: 0 });
    }
    if (path.includes("/investigations")) return jsonResponse({ freeText: null, items: [] });
    if (path.includes("/procedures")) return jsonResponse([]);
    if (path.includes("/api/services")) return jsonResponse([]);
    if (path.includes("/medications")) return jsonResponse([]);
    return inner(path, init);
  };
}

function renderScreen(authFetch: (path: string, init?: RequestInit) => Promise<Response>) {
  return render(
    <LocaleProvider>
      <VisitDraftScreen authFetch={withPanels(authFetch)} appointmentId="appt-1" delayMs={50} />
    </LocaleProvider>,
  );
}

const stateOf = () => screen.getByTestId("save-state").getAttribute("data-state");

beforeEach(() => {
  window.localStorage.clear();
  // The savers are module state and outlive a component on purpose (Q35), so one test's draft
  // would otherwise arrive in the next carrying its save state.
  resetSavers();
});

afterEach(cleanup);

describe("the autosave indicator", () => {
  test("never says saved before the server confirms, and says it once it does", async () => {
    // The save is **held open**, so "before the server has answered" is a state this test controls
    // rather than a window it races. It used to assert "unsaved" immediately after typing, which
    // holds only if nine keystrokes fit inside the 50ms debounce — and on a loaded parallel run
    // they do not. That failed once in a full run on 2026-09-09 and passed alone; forcing the gap
    // with `{ delay: 60 }` reproduced it on demand: `expected 'saved' to be 'unsaved'`.
    //
    // A save landing mid-typing is correct behaviour, so the timing was never the invariant. Q4's
    // invariant is that nothing claims "saved" while the text has only reached this device.
    let confirmSave = (): void => {};
    const serverAnswered = new Promise<void>((resolve) => {
      confirmSave = resolve;
    });
    const authFetch = vi.fn(async (_path: string, init?: RequestInit) => {
      if (init?.method === "POST") return jsonResponse(DRAFT, 201);
      await serverAnswered;
      return jsonResponse({ ...DRAFT, revision: 1, diagnosis: "sinusitis" });
    });

    renderScreen(authFetch);
    await screen.findByLabelText(/Diagnosis|التشخيص/);

    // Typed key by key, which is what the debounce actually sees. A single change event would not
    // exercise the timer being reset on every keystroke.
    await userEvent.type(screen.getByLabelText(/Diagnosis|التشخيص/), "sinusitis");

    // Waited for, not sampled: the request is in flight and the server has not answered, which is
    // the only moment where a wrong indicator would actually deceive anyone. Sampling straight
    // after typing proved too weak to catch it — announcing "saved" at the *start* of the save
    // passed, because the debounce had not fired yet when the assertion ran.
    await waitFor(() => expect(stateOf()).toBe("saving"));
    expect(stateOf()).not.toBe("saved");

    confirmSave();
    await waitFor(() => expect(stateOf()).toBe("saved"));
  });

  test("a failed save never says saved, and the text stays on the device", async () => {
    // The failure mode Q4 names: an indicator that reassures while the text exists nowhere but here.
    const authFetch = vi.fn(async (_path: string, init?: RequestInit) => {
      if (init?.method === "POST") return jsonResponse(DRAFT, 201);
      return jsonResponse({ code: "INTERNAL", params: {} }, 500);
    });

    renderScreen(authFetch);
    await screen.findByLabelText(/Diagnosis|التشخيص/);
    await userEvent.type(screen.getByLabelText(/Diagnosis|التشخيص/), "sinusitis");

    await waitFor(() => expect(stateOf()).toBe("failed"));
    expect(stateOf()).not.toBe("saved");
    expect(recall("visit-1")?.text.diagnosis).toBe("sinusitis");
  });

  test("a stale save is shown as stale, not as a generic failure", async () => {
    // Q7 reaching the screen: the doctor must be told someone else saved, because reloading is the
    // action, and retrying is not.
    const authFetch = vi.fn(async (_path: string, init?: RequestInit) => {
      if (init?.method === "POST") return jsonResponse(DRAFT, 201);
      return jsonResponse({ code: "STALE_REVISION", params: { revision: 4 } }, 409);
    });

    renderScreen(authFetch);
    await screen.findByLabelText(/Diagnosis|التشخيص/);
    await userEvent.type(screen.getByLabelText(/Diagnosis|التشخيص/), "x");

    await waitFor(() => expect(stateOf()).toBe("stale"));
  });

  test("text that never reached the server is restored and announced", async () => {
    // Simulates the kill: local copy at the server's current revision, server text empty.
    window.localStorage.setItem(
      "clinic-os.visit-draft.visit-1",
      JSON.stringify({
        visitId: "visit-1",
        revision: 0,
        text: { diagnosis: "TYPED-BEFORE-CRASH" },
        savedAt: "2026-09-07T10:00:00.000Z",
      }),
    );

    const authFetch = vi.fn(async () => jsonResponse(DRAFT, 201));
    renderScreen(authFetch);

    await screen.findByTestId("recovered");
    // The field carries the recovered text, and the state says unsaved -- never "saved", because
    // the server has never seen it.
    expect(screen.getByDisplayValue("TYPED-BEFORE-CRASH")).toBeTruthy();
    expect(stateOf()).toBe("unsaved");
  });
});
