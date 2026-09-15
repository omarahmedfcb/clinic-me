import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { LocaleProvider } from "../../i18n/locale-context.tsx";
import { PaymentsPage } from "./PaymentsPage.tsx";

/**
 * «المدفوعات» — R2.
 *
 * The screen's own rule, and the only one worth a test here: **`mayCollect` is what the server
 * says, and the screen offers nothing when it is false.** The routes refuse regardless, so this is
 * about not showing an admin a button that would be refused — not about access control.
 */

const OVERVIEW = {
  day: "2026-09-11",
  byMethod: [{ method: "CASH", totalMinor: 40_000 }],
  collectedTodayMinor: 40_000,
  outstandingMinor: 60_000,
  charges: [
    {
      chargeId: "c1",
      visitId: "v1",
      patientId: "p1",
      patientName: "مريم حسن",
      doctorName: "د. هشام",
      status: "OPEN",
      subtotalMinor: 100_000,
      discountMinor: 0,
      paidMinor: 40_000,
      balanceMinor: 60_000,
      today: true,
    },
  ],
  receipts: [
    {
      paymentId: "pay1",
      receiptNumber: 41,
      patientName: "مريم حسن",
      amountMinor: 40_000,
      method: "CASH",
      collectedBy: "شيماء",
    },
  ],
  adjustments: [
    {
      visitId: "v1",
      patientName: "مريم حسن",
      doctorName: "د. هشام",
      amountMinor: -20_000,
      reason: "مريض منتظم",
      at: "2026-09-11T09:00:00.000Z",
    },
  ],
  aboveCeiling: [],
  mayCollect: true,
};

function renderPage(overview: unknown, onOpen = vi.fn()) {
  const authFetch = vi.fn(
    async () =>
      new Response(JSON.stringify(overview), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  );
  render(
    <LocaleProvider>
      <PaymentsPage authFetch={authFetch} currency="EGP" onOpenCharge={onOpen} />
    </LocaleProvider>,
  );
  return onOpen;
}

afterEach(cleanup);

describe("the payments screen", () => {
  test("shows the day's takings, what is outstanding, and the invoices behind them", async () => {
    renderPage(OVERVIEW);
    await screen.findByTestId("payments-charges");
    expect(screen.getByTestId("collected-today").textContent).toContain("400");
    expect(screen.getByTestId("outstanding").textContent).toContain("600");
    // The same patient appears in the invoice list, the receipts and the adjustments.
    expect(screen.getAllByText("مريم حسن").length).toBeGreaterThan(0);
  });

  test("a doctor's adjustments are on the screen, which is what replaced the review queue", async () => {
    renderPage(OVERVIEW);
    const list = await screen.findByTestId("payments-adjustments");
    // Signed and rendered as a reduction, because that is what the doctor did — and signed by
    // `Intl`, which puts an LRM before its own minus so the sign stays inside the number's
    // left-to-right run. A hand-written `−` sits outside it and detaches in an Arabic paragraph.
    expect(list.textContent).toContain("‎-");
    expect(list.textContent).toContain("200");
  });

  test("a reader who may not collect gets no desk button and is told why", async () => {
    renderPage({ ...OVERVIEW, mayCollect: false });
    await screen.findByTestId("payments-charges");
    expect(screen.queryByTestId("open-c1")).toBeNull();
    expect(screen.getByTestId("payments-read-only")).toBeTruthy();
  });

  test("a reader who may collect opens the desk from a row", async () => {
    const onOpen = renderPage(OVERVIEW);
    const button = await screen.findByTestId("open-c1");
    button.click();
    expect(onOpen).toHaveBeenCalledWith("c1");
  });
});
