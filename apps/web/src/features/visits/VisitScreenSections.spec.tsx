import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LocaleProvider } from "../../i18n/locale-context.tsx";
import { translate } from "../../i18n/strings.ts";
import { VisitDraftScreen } from "./VisitDraftScreen.tsx";
import { resetSavers } from "./draft-autosave.ts";

/**
 * The sections Q21–Q27 added, driven through the real screen.
 *
 * The three assertions that carry this file: the stock button stays disabled and inert (Q27, a
 * deliberate exception to the no-dead-buttons rule); ending the visit reports **whether the
 * follow-up was actually booked** rather than assuming it was (Q24, Q26); and the per-visit history
 * field is labelled as the history of *present illness* (Q23), because one field was carrying two
 * different questions.
 */

const DRAFT = {
  id: "visit-1",
  appointmentId: "appt-1",
  revision: 3,
  complaint: null,
  medicalHistory: null,
  examination: null,
  diagnosis: null,
  treatmentPlan: null,
  doctorNotes: null,
  updatedAt: "2026-09-08T10:00:00.000Z",
  resumed: false,
};

const HEADER = {
  patientId: "patient-1",
  fullNameAr: "مريم حسن",
  fullNameEn: null,
  dateOfBirth: "1990-04-02",
  gender: "FEMALE",
  phoneE164: "+201000000000",
  allergies: [{ id: "a1", substance: "بنسلين", severity: "SEVERE" }],
  allergiesReviewedAt: "2026-09-01T09:00:00.000Z",
  coverage: { standing: "COVERED" as const, insurerName: "مصر للتأمين" },
  visitCount: 4,
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

/** Every panel answered, with the completion response the individual test wants. */
function fetcher(complete: () => Response) {
  return vi.fn(async (path: string, init?: RequestInit) => {
    if (path.includes("/visit/visit-1/complete")) return complete();
    if (path.endsWith("/visit/draft") && init?.method === "POST") return jsonResponse(DRAFT, 201);
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
    return jsonResponse(DRAFT);
  });
}

function renderScreen(authFetch: (path: string, init?: RequestInit) => Promise<Response>) {
  return render(
    <LocaleProvider>
      <VisitDraftScreen authFetch={authFetch} appointmentId="appt-1" delayMs={20} currency="EGP" />
    </LocaleProvider>,
  );
}

beforeEach(() => {
  window.localStorage.clear();
  // The savers are module state and outlive a component on purpose (Q35), so one test's draft
  // would otherwise arrive in the next carrying its save state.
  resetSavers();
});

afterEach(cleanup);

describe("the visit screen after Q21-Q27", () => {
  test("the patient header names the patient and puts the allergy in an alert", async () => {
    renderScreen(fetcher(() => jsonResponse({}, 500)));

    // 5s rather than the 1s default. The header waits on three fetches, and under a full parallel
    // run this timed out at 1421ms once on 2026-09-10 while passing alone -- the same shape as the
    // autosave race fixed on 2026-09-09. Waiting longer weakens nothing: a header that never
    // renders still fails.
    const header = await screen.findByTestId("patient-header", {}, { timeout: 5_000 });
    expect(header.textContent).toContain("مريم حسن");
    expect(header.textContent).toContain("+201000000000");
    expect(header.textContent).toContain("مصر للتأمين");
    // The allergy is a role="alert", not a line of grey text: Q21 asks for a red alert because the
    // doctor was working on an anonymous record.
    expect((await screen.findByTestId("allergy-alert")).textContent).toContain("بنسلين");
  });

  test("the per-visit history field asks for the history of present illness (Q23)", async () => {
    renderScreen(fetcher(() => jsonResponse({}, 500)));
    // Past history lives in the profile now; this field must not read as "medical history" or it
    // gets retyped from scratch every visit, which is the defect Q23 names.
    await screen.findByLabelText("تاريخ الشكوى الحالية");
    expect(screen.queryByLabelText("التاريخ المرضي")).toBeNull();
    // Asserted in both languages, and separately. The rendered label is Arabic, so an English
    // string left behind would sail past a check on the screen alone — which it did, once.
    expect(translate("en", "draft.field.medicalHistory")).toBe("History of present illness");
  });

  test("the stock button is present, disabled, labelled coming soon, and does nothing (Q27)", async () => {
    const authFetch = fetcher(() => jsonResponse({}, 500));
    renderScreen(authFetch);

    const stock = await screen.findByTestId("stock-button");
    expect(stock.hasAttribute("disabled")).toBe(true);
    expect(stock.textContent).toContain("قريبًا");

    await userEvent.click(stock, { pointerEventsCheck: 0 });
    // No handler, so nothing is requested on its behalf — a visible gap is information; a gap that
    // acts is a bug. Asserted against the paths rather than a call count: the other panels on this
    // screen fetch on their own schedule, and a count would fail for their reasons rather than this
    // button's.
    expect(authFetch.mock.calls.filter(([path]) => path.includes("stock"))).toEqual([]);
  });

  test("ending the visit says the follow-up was booked, and names the day", async () => {
    const authFetch = fetcher(() =>
      jsonResponse({
        visitId: "visit-1",
        revision: 4,
        completedAt: "2026-09-08T11:00:00.000Z",
        appointmentStatus: "COMPLETED",
        followUpDate: "2026-09-22",
        followUpAppointmentId: "appt-2",
      }, 201),
    );
    renderScreen(authFetch);

    await userEvent.click(await screen.findByTestId("end-visit"));
    await waitFor(() =>
      expect(screen.getByTestId("end-visit-message").textContent).toContain("2026-09-22"),
    );
    expect(screen.getByTestId("end-visit-message").textContent).toContain("حُجزت");
  });

  test("a follow-up the diary could not take is reported, never swallowed", async () => {
    // The case D30 leaves open on purpose: the visit completes, and nothing has been booked. A
    // screen that said "visit ended" here would hide a follow-up nobody knows is missing.
    const authFetch = fetcher(() =>
      jsonResponse({
        visitId: "visit-1",
        revision: 4,
        completedAt: "2026-09-08T11:00:00.000Z",
        appointmentStatus: "COMPLETED",
        followUpDate: "2026-09-22",
        followUpAppointmentId: null,
      }, 201),
    );
    renderScreen(authFetch);

    await userEvent.click(await screen.findByTestId("end-visit"));
    await waitFor(() =>
      expect(screen.getByTestId("end-visit-message").textContent).toContain("الاستقبال"),
    );
  });

  test("completing sends the revision the screen last had confirmed", async () => {
    const authFetch = fetcher(() =>
      jsonResponse({
        visitId: "visit-1",
        revision: 4,
        completedAt: "2026-09-08T11:00:00.000Z",
        appointmentStatus: "COMPLETED",
        followUpDate: null,
        followUpAppointmentId: null,
      }, 201),
    );
    renderScreen(authFetch);

    await userEvent.click(await screen.findByTestId("end-visit"));
    await waitFor(() => expect(screen.getByTestId("end-visit-message")).toBeTruthy());

    const call = authFetch.mock.calls.find(([path]) => path.includes("/complete"));
    // Compare-and-set, not a bare finish: the draft opened at revision 3 and that is what goes.
    expect(JSON.parse(String(call?.[1]?.body)).expectedRevision).toBe(3);
  });

  test("printing records the count before it opens the dialog (Q9)", async () => {
    const authFetch = fetcher(() => jsonResponse({}, 500));
    const print = vi.spyOn(window, "print").mockImplementation(() => undefined);
    renderScreen(authFetch);

    await userEvent.click(await screen.findByTestId("print-button"));

    // Recorded first, because the dialog is modal and its outcome is not observable: a browser
    // reports nothing about whether paper came out, so "the doctor pressed print" is the honest
    // thing this can know.
    const recorded = authFetch.mock.calls.find(([path]) => path.includes("/prescription/printed"));
    expect(recorded?.[1]?.method).toBe("POST");
    expect(print).toHaveBeenCalledTimes(1);
    print.mockRestore();
  });

  test("a completion refused as stale is shown as stale, and the visit is not claimed finished", async () => {
    const authFetch = fetcher(() =>
      jsonResponse({ code: "STALE_REVISION", params: { revision: 9 } }, 409),
    );
    renderScreen(authFetch);

    await userEvent.click(await screen.findByTestId("end-visit"));
    await waitFor(() =>
      expect(screen.getByTestId("end-visit-message").textContent).toContain("أعد التحميل"),
    );
  });
});
