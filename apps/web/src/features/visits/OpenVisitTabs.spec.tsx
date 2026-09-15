import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { LocaleProvider } from "../../i18n/locale-context.tsx";
import { OpenVisitTabs } from "./OpenVisitTabs.tsx";
import { resetSavers, saverFor } from "./draft-autosave.ts";

/**
 * The tab bar Q35 asks for, driven through the real component.
 *
 * The assertion that carries this file is the second: **each tab reports its own draft's state.** A
 * strip that showed one word for two patients would be worse than no strip — the doctor would read
 * "saved" about the visit they were not looking at.
 */

const OPEN = [
  {
    appointmentId: "appt-1",
    patientId: "patient-1",
    patientName: "مريم حسن",
    status: "IN_CONSULTATION" as const,
    visitId: "visit-1",
  },
  {
    appointmentId: "appt-2",
    patientId: "patient-2",
    patientName: "أحمد فؤاد",
    status: "PAUSED" as const,
    visitId: "visit-2",
  },
];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function renderTabs(open: unknown = OPEN) {
  const authFetch = vi.fn(async () => jsonResponse(open));
  render(
    <LocaleProvider>
      <OpenVisitTabs authFetch={authFetch} currentAppointmentId="appt-1" />
    </LocaleProvider>,
  );
  return authFetch;
}

/** Drives a saver to a terminal state without waiting on its debounce. */
async function driveTo(visitId: string, outcome: "saved" | "failed"): Promise<void> {
  const authFetch = vi.fn(async () =>
    outcome === "saved"
      ? jsonResponse({
          id: visitId,
          appointmentId: `appt-${visitId}`,
          doctorId: "doctor-1",
          revision: 1,
          complaint: null,
          medicalHistory: null,
          examination: null,
          diagnosis: null,
          treatmentPlan: null,
          doctorNotes: null,
          updatedAt: "2026-09-09T10:00:00.000Z",
          resumed: true,
        })
      : jsonResponse({ code: "INTERNAL", params: {} }, 500),
  );
  const saver = saverFor(visitId, { authFetch, appointmentId: `appt-${visitId}`, delayMs: 10_000 });
  saver.queue({ diagnosis: "typed" });
  await saver.flush();
}

beforeEach(() => {
  resetSavers();
});

afterEach(cleanup);

describe("the open-visit tabs", () => {
  test("one open consultation is not a set of tabs", async () => {
    renderTabs([OPEN[0]]);
    // The screen you are already on does not need a tab pointing at it.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(screen.queryByTestId("open-visit-tabs")).toBeNull();
  });

  test("each tab reports its own draft's save state", async () => {
    await driveTo("visit-1", "failed");
    await driveTo("visit-2", "saved");
    renderTabs();

    const failing = await screen.findByTestId("visit-tab-state-appt-1");
    const working = await screen.findByTestId("visit-tab-state-appt-2");
    expect(failing.textContent).toBe("تعذّر الحفظ");
    expect(working.textContent).toBe("محفوظ");
  });

  test("the current tab is marked, and a paused consultation says so", async () => {
    renderTabs();
    const current = await screen.findByTestId("visit-tab-appt-1");
    const other = await screen.findByTestId("visit-tab-appt-2");
    expect(current.getAttribute("aria-current")).toBe("page");
    expect(other.getAttribute("aria-current")).toBeNull();
    // Q34: paused is a state reception and the doctor both need to see named, not inferred.
    expect(other.textContent).toContain("الكشف متوقف مؤقتًا");
  });

  test("a payload that is not a list leaves the screen alone", async () => {
    // A type is a claim about a payload, not a validation of one. A tab strip must never be the
    // reason a doctor cannot reach the visit they are typing into.
    renderTabs({ not: "an array" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(screen.queryByTestId("open-visit-tabs")).toBeNull();
  });
});
