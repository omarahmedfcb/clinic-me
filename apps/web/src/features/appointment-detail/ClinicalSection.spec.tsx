import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { LocaleProvider } from "../../i18n/locale-context.tsx";
import { ClinicalSection } from "./ClinicalSection.tsx";

/**
 * The presence refusal is re-asked when the appointment's status changes.
 *
 * The defect, found on review 2026-09-07: a doctor opened a CONFIRMED appointment, pressed "start
 * consultation", and the panel still told them the patient was not with them. The server was right
 * throughout — `PATCH /queue/:id/start` returned 200 and the appointment was IN_CONSULTATION. The
 * client had fetched `clinical-history` once on open, latched `NOT_PRESENT`, and never re-asked,
 * because the effect depended only on the appointment id, which had not changed.
 */

const SUMMARY = {
  patientId: "p1",
  dateOfBirth: null,
  gender: null,
  allergies: [],
  allergiesReviewedAt: null,
  currentMedication: [],
  activeTreatmentPlans: [],
  recentVisits: [],
  mayReadFullHistory: false,
  appointmentStatus: "CONFIRMED",
};

const HISTORY = { visits: [], prescriptions: [] };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Answers exactly as the API does: 409 while the patient is not present, 200 once they are. */
function apiFor(statusOf: () => string) {
  return vi.fn(async () =>
    ["ARRIVED", "WAITING", "IN_CONSULTATION"].includes(statusOf())
      ? jsonResponse(HISTORY)
      : jsonResponse({ code: "NOT_PRESENT", params: {} }, 409),
  );
}

vi.mock("../auth/session.tsx", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../auth/session.tsx");
  return { ...actual, useSession: () => ({ authFetch: currentFetch, me: { permissions: [] } }) };
});

let currentFetch: (path: string, init?: RequestInit) => Promise<Response> = async () =>
  jsonResponse(HISTORY);

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(cleanup);

describe("the clinical section re-reads when the appointment status changes", () => {
  test("a refusal latched at CONFIRMED is gone once the consultation starts", async () => {
    let status = "CONFIRMED";
    currentFetch = apiFor(() => status);

    const view = render(
      <LocaleProvider>
        <ClinicalSection appointmentId="a1" summary={SUMMARY as never} status={"CONFIRMED" as never} />
      </LocaleProvider>,
    );

    // The panel opened before the patient was called through: the server refuses, correctly.
    await waitFor(() => expect(screen.getByText(/السجل الكامل يفتح|The full record opens/)).toBeTruthy());

    // "ابدأ الكشف" — the appointment is now IN_CONSULTATION and the queue has refreshed.
    status = "IN_CONSULTATION";
    view.rerender(
      <LocaleProvider>
        <ClinicalSection
          appointmentId="a1"
          summary={SUMMARY as never}
          status={"IN_CONSULTATION" as never}
        />
      </LocaleProvider>,
    );

    // Before the fix this never happened: the id had not changed, so nothing re-asked and the
    // presence message stayed on screen while the patient sat in the room.
    await waitFor(() => expect(screen.queryByText(/السجل الكامل يفتح|The full record opens/)).toBeNull());
  });

  test("the read is actually repeated, not merely re-rendered", async () => {
    // Asserted on the call count as well as the rendering: a component that hid the message
    // locally without re-asking would pass the test above and still be wrong, because the server
    // is the only thing that decides presence.
    let status = "CONFIRMED";
    const authFetch = apiFor(() => status);
    currentFetch = authFetch;

    const view = render(
      <LocaleProvider>
        <ClinicalSection appointmentId="a1" summary={SUMMARY as never} status={"CONFIRMED" as never} />
      </LocaleProvider>,
    );
    await waitFor(() => expect(authFetch).toHaveBeenCalledTimes(1));

    status = "IN_CONSULTATION";
    view.rerender(
      <LocaleProvider>
        <ClinicalSection
          appointmentId="a1"
          summary={SUMMARY as never}
          status={"IN_CONSULTATION" as never}
        />
      </LocaleProvider>,
    );

    await waitFor(() => expect(authFetch).toHaveBeenCalledTimes(2));
  });
});
