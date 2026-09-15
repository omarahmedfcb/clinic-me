import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { LocaleProvider } from "../../i18n/locale-context.tsx";
import { MyPatientsTab } from "./MyPatientsTab.tsx";

/**
 * «مرضاي» — R-B, 2026-09-14.
 *
 * The tab is the entry point to a doctor's own records, which makes it the worst place to render a
 * confident empty state out of a failed read: "you have treated nobody" is a claim, not an absence.
 * The rest of the rule lives on the server and is proven there — this screen must not restate it.
 */

const PAGE = {
  patients: [
    {
      id: "11111111-1111-4111-8111-111111111111",
      fullNameAr: "سلمى عبد الرحمن",
      fullNameEn: null,
      phoneE164: "+201000000001",
      dateOfBirth: null,
      status: "ACTIVE" as const,
      missingIntakeFields: [],
      lastVisitAt: "2026-09-01T09:00:00.000Z",
      visitCount: 3,
    },
  ],
  total: 1,
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function renderTab(
  handler: (path: string) => Promise<Response>,
  onOpen: (id: string) => void = () => {},
) {
  const authFetch = vi.fn(async (path: string) => handler(path));
  render(
    <LocaleProvider>
      <MyPatientsTab authFetch={authFetch} onOpen={onOpen} />
    </LocaleProvider>,
  );
  return authFetch;
}

afterEach(cleanup);

describe("«مرضاي»", () => {
  test("lists the doctor's own patients, with how many times each was seen", async () => {
    renderTab(async () => json(PAGE));
    const list = await screen.findByTestId("my-patients-list");

    expect(list.textContent).toContain("سلمى عبد الرحمن");
    expect(list.textContent).toContain("+201000000001");
    // The count is of visits with *this* doctor, and is rendered in Latin digits like every figure.
    expect(list.textContent).toContain("3");
  });

  test("a failed read says so, and never renders an empty list", async () => {
    renderTab(async () => json({ code: "INTERNAL", params: {} }, 500));
    expect(await screen.findByTestId("my-patients-failed")).toBeTruthy();
    expect(screen.queryByTestId("my-patients-list")).toBeNull();
    // "You have treated nobody" would be a false statement made out of a failed request.
    expect(screen.queryByText("لم تُنهِ كشفًا لأي مريض بعد.")).toBeNull();
  });

  test("an unreadable payload is a failure too", async () => {
    renderTab(async () => json({ total: 1 }));
    expect(await screen.findByTestId("my-patients-failed")).toBeTruthy();
  });

  test("search asks the server, inside the doctor's own list", async () => {
    const authFetch = renderTab(async () => json(PAGE));
    await screen.findByTestId("my-patients-list");

    fireEvent.change(screen.getByTestId("my-patients-search"), { target: { value: "سلمى" } });

    await waitFor(() => {
      const asked = authFetch.mock.calls.map(([path]) => String(path));
      // `/patients/mine`, never `/patients?q=` — the clinic-wide search is a different question.
      expect(asked.some((path) => path.startsWith("/api/patients/mine?") && path.includes("q="))).toBe(
        true,
      );
      expect(asked.some((path) => path.startsWith("/api/patients?"))).toBe(false);
    });
  });

  test("picking a patient opens their record", async () => {
    const onOpen = vi.fn();
    renderTab(async () => json(PAGE), onOpen);
    fireEvent.click(await screen.findByTestId(`my-patient-${PAGE.patients[0]?.id ?? ""}`));
    expect(onOpen).toHaveBeenCalledWith(PAGE.patients[0]?.id);
  });
});
