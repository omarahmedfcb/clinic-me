import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { LocaleProvider } from "../../i18n/locale-context.tsx";
import { ReportsPage } from "./ReportsPage.tsx";

/**
 * «تقارير المدفوعات» — Phase 5 PR 14.
 *
 * The screen's own share: a failed read must not render as a quiet day, and a doctor reading their
 * **own** figures must be told they are their own. A total that looks clinic-wide and is not is the
 * kind of number somebody makes a decision on.
 */

const REPORT = {
  period: "DAY" as const,
  on: "2026-09-13",
  from: "2026-09-13",
  to: "2026-09-13",
  collectedMinor: 90_000,
  byMethod: [{ method: "CASH", totalMinor: 90_000 }],
  byDoctor: [
    {
      doctorId: "d1",
      doctorName: "د. منى سيد",
      collectedMinor: 40_000,
      chargedMinor: 100_000,
      outstandingMinor: 60_000,
      charges: 1,
    },
  ],
  outstandingMinor: 60_000,
  outstanding: [
    {
      chargeId: "c1",
      patientName: "مريم حسن",
      doctorName: "د. منى سيد",
      issuedOn: "2026-09-13",
      balanceMinor: 60_000,
    },
  ],
  adjustments: [],
  aboveCeiling: [],
  scope: "CLINIC" as const,
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function renderPage(handler?: (path: string) => Promise<Response>) {
  const authFetch = vi.fn(async (path: string, _init?: RequestInit) =>
    handler !== undefined ? handler(path) : json(REPORT),
  );
  render(
    <LocaleProvider>
      <ReportsPage authFetch={authFetch} currency="EGP" />
    </LocaleProvider>,
  );
  return authFetch;
}

afterEach(cleanup);

describe("the payments report", () => {
  test("shows what came in, what is owed, and the per-doctor breakdown", async () => {
    renderPage();
    await screen.findByTestId("report");

    expect(screen.getByTestId("report-collected").textContent).toContain("900");
    expect(screen.getByTestId("report-outstanding").textContent).toContain("600");
    expect(screen.getByTestId("report-by-doctor").textContent).toContain("د. منى سيد");
    expect(screen.getByTestId("report-outstanding-list").textContent).toContain("مريم حسن");
  });

  /**
   * **It opens on the month — ruled 2026-09-14**, and this is the guard for that ruling.
   *
   * A day with no receipts yet is every morning and every quiet day, and the first request the
   * screen makes decides what the reader sees before they touch anything.
   */
  test("the first request is for the month, not the day", async () => {
    const authFetch = renderPage();
    await screen.findByTestId("report");

    const first = String(authFetch.mock.calls[0]?.[0] ?? "");
    expect(first).toContain("period=MONTH");
    expect(first).not.toContain("period=DAY");
    expect(screen.getByTestId("report-period-MONTH").getAttribute("aria-pressed")).toBe("true");
  });

  test("switching to a day asks for a day", async () => {
    const authFetch = renderPage();
    await screen.findByTestId("report");

    fireEvent.click(screen.getByTestId("report-period-DAY"));

    await waitFor(() => {
      const asked = authFetch.mock.calls.map(([path]) => String(path));
      expect(asked.some((path) => path.includes("period=DAY"))).toBe(true);
    });
  });

  test("changing the period rewrites the date so a day is never sent as a month", async () => {
    // The refusal this avoids is `INVALID_PERIOD`, and discovering it by being refused would be a
    // rude way for the screen to say something it already knows.
    const authFetch = renderPage();
    await screen.findByTestId("report");

    fireEvent.click(screen.getByTestId("report-period-DAY"));
    fireEvent.change(screen.getByTestId("report-on"), { target: { value: "2026-09-13" } });
    fireEvent.click(screen.getByTestId("report-period-MONTH"));

    await waitFor(() => {
      const asked = authFetch.mock.calls.map(([path]) => String(path));
      expect(asked.some((path) => path.includes("period=MONTH") && path.includes("on=2026-09"))).toBe(
        true,
      );
      expect(asked.some((path) => path.includes("period=MONTH") && path.includes("on=2026-09-13"))).toBe(
        false,
      );
    });
  });

  test("a doctor is told the figures are their own", async () => {
    renderPage(async () => json({ ...REPORT, scope: "OWN" }));
    expect(await screen.findByTestId("report-own-scope")).toBeTruthy();
  });

  test("a clinic-wide report says nothing about scope", async () => {
    renderPage();
    await screen.findByTestId("report");
    expect(screen.queryByTestId("report-own-scope")).toBeNull();
  });

  test("a failed read says so, and never renders a day on which nothing happened", async () => {
    renderPage(async () => json({ code: "INTERNAL", params: {} }, 500));
    expect(await screen.findByTestId("report-failed")).toBeTruthy();
    expect(screen.queryByTestId("report")).toBeNull();
  });

  test("nothing on the screen writes: every request is a GET", async () => {
    const authFetch = renderPage();
    await screen.findByTestId("report");
    fireEvent.click(screen.getByTestId("report-period-DAY"));

    await waitFor(() => expect(authFetch.mock.calls.length).toBeGreaterThan(1));
    for (const [, init] of authFetch.mock.calls) {
      expect((init as RequestInit | undefined)?.method ?? "GET").toBe("GET");
    }
  });
});
