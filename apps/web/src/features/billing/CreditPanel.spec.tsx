import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { LocaleProvider } from "../../i18n/locale-context.tsx";
import { CreditPanel } from "./CreditPanel.tsx";

/**
 * Clinic credit on screen — ruling 5.
 *
 * The balance and its history, the two things that may be done with it, and the one thing the panel
 * must never do: report a zero balance when what it actually knows is that it could not read one.
 */

const LEDGER = {
  patientId: "p1",
  balanceMinor: 50_000,
  creditedMinor: 90_000,
  appliedMinor: 30_000,
  refundedMinor: 10_000,
  movements: [
    {
      id: "m1",
      movement: "CREDIT" as const,
      amountMinor: 90_000,
      reason: "PRE_PAYMENT_ABOVE_BILL",
      actorName: "شيماء طارق بدوي",
      receiptNumber: 41,
      appliedChargeId: null,
      at: "2026-09-10T09:00:00.000Z",
    },
    {
      id: "m2",
      movement: "APPLIED" as const,
      amountMinor: 30_000,
      reason: null,
      actorName: "شيماء طارق بدوي",
      receiptNumber: null,
      appliedChargeId: "c1",
      at: "2026-09-11T09:00:00.000Z",
    },
    {
      id: "m3",
      movement: "REFUNDED" as const,
      amountMinor: 10_000,
      reason: "المريضة طلبت استرداد الرصيد",
      actorName: "منى سيد فهمي",
      receiptNumber: null,
      appliedChargeId: null,
      at: "2026-09-12T09:00:00.000Z",
    },
  ],
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function renderPanel(
  handler: (path: string, init?: RequestInit) => Promise<Response>,
  props: { chargeId?: string; chargeBalanceMinor?: number; allowRefund?: boolean } = {},
) {
  const authFetch = vi.fn(handler);
  render(
    <LocaleProvider>
      <CreditPanel authFetch={authFetch} patientId="p1" currency="EGP" {...props} />
    </LocaleProvider>,
  );
  return authFetch;
}

afterEach(cleanup);

describe("the credit panel", () => {
  test("shows the balance and the movements that produced it", async () => {
    renderPanel(async () => json(LEDGER));
    await screen.findByTestId("credit-panel");

    expect(screen.getByTestId("credit-balance").textContent).toContain("500");
    const ledger = screen.getByTestId("credit-ledger");
    // Each movement says what it was, and a credit says which receipt it came from.
    expect(ledger.textContent).toContain("41");
    expect(ledger.textContent).toContain("المريضة طلبت استرداد الرصيد");
    expect(ledger.textContent).toContain("شيماء طارق بدوي");
    // A credit the system raised carries a code, and the ledger reads it in Arabic. A refund
    // carries what a person typed, above, and is shown exactly as they wrote it.
    expect(ledger.textContent).toContain("دفعة مقدَّمة أكبر من الفاتورة");
    expect(ledger.textContent).not.toContain("PRE_PAYMENT_ABOVE_BILL");
  });

  /** R-A: credit is a payment against the bill, so it stops at what the bill still owes. */
  test("more credit than the bill owes is refused by the button", async () => {
    renderPanel(async () => json(LEDGER), { chargeId: "c1", chargeBalanceMinor: 12_000 });
    await screen.findByTestId("credit-panel");

    fireEvent.change(screen.getByTestId("credit-apply-amount"), { target: { value: "200" } });
    expect(screen.getByTestId("credit-over-charge")).toBeTruthy();
    expect(screen.getByTestId("credit-apply")).toHaveProperty("disabled", true);

    // Exactly what is owed is the ordinary act and stays allowed.
    fireEvent.change(screen.getByTestId("credit-apply-amount"), { target: { value: "120" } });
    expect(screen.queryByTestId("credit-over-charge")).toBeNull();
    expect(screen.getByTestId("credit-apply")).toHaveProperty("disabled", false);
  });

  test("a refused read says so, and never reports a zero balance", async () => {
    // The mistake this guards: money is the worst place to render "nothing here" when what is
    // known is "could not say".
    renderPanel(async () => json({ code: "INTERNAL", params: {} }, 500));
    expect(await screen.findByTestId("credit-failed")).toBeTruthy();
    expect(screen.queryByTestId("credit-balance")).toBeNull();
  });

  test("an unreadable payload is a failure too, not an empty ledger", async () => {
    renderPanel(async () => json({}));
    expect(await screen.findByTestId("credit-failed")).toBeTruthy();
    expect(screen.queryByTestId("credit-balance")).toBeNull();
  });

  test("the desk can apply credit to the bill it is showing", async () => {
    const authFetch = renderPanel(
      async (_path, init) => {
        if (init?.method === "POST") return json({ appliedMinor: 20_000, balanceMinor: 30_000 });
        return json(LEDGER);
      },
      { chargeId: "c1" },
    );
    await screen.findByTestId("credit-panel");

    fireEvent.change(screen.getByTestId("credit-apply-amount"), { target: { value: "200" } });
    fireEvent.click(screen.getByTestId("credit-apply"));

    await waitFor(() => {
      const post = authFetch.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === "POST");
      expect(post).toBeDefined();
      expect(String((post as [string, RequestInit])[0])).toBe("/api/charges/c1/credit");
      expect(JSON.parse((post as [string, RequestInit])[1].body as string)).toEqual({ amountMinor: 20_000 });
    });
  });

  test("the patient card refunds, and will not send one without a reason", async () => {
    const authFetch = renderPanel(
      async (_path, init) => {
        if (init?.method === "POST") return json({ refundedMinor: 10_000, balanceMinor: 40_000 });
        return json(LEDGER);
      },
      { allowRefund: true },
    );
    await screen.findByTestId("credit-panel");

    fireEvent.change(screen.getByTestId("credit-refund-amount"), { target: { value: "100" } });
    // The amount alone is not enough: a refund nobody stated a reason for is the row somebody has
    // to explain a year later.
    expect(screen.getByTestId("credit-refund")).toHaveProperty("disabled", true);

    fireEvent.change(screen.getByTestId("credit-refund-reason"), { target: { value: "طلب المريض" } });
    fireEvent.click(screen.getByTestId("credit-refund"));

    await waitFor(() => {
      const post = authFetch.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === "POST");
      expect(post).toBeDefined();
      expect(String((post as [string, RequestInit])[0])).toBe("/api/patients/p1/credit/refund");
      expect(JSON.parse((post as [string, RequestInit])[1].body as string)).toEqual({
        amountMinor: 10_000,
        reason: "طلب المريض",
      });
    });
  });

  test("the desk is not where credit is given back, and the card is not where it is spent", async () => {
    renderPanel(async () => json(LEDGER), { chargeId: "c1" });
    await screen.findByTestId("credit-panel");
    expect(screen.getByTestId("credit-apply")).toBeTruthy();
    expect(screen.queryByTestId("credit-refund")).toBeNull();

    cleanup();
    renderPanel(async () => json(LEDGER), { allowRefund: true });
    await screen.findByTestId("credit-panel");
    expect(screen.getByTestId("credit-refund")).toBeTruthy();
    expect(screen.queryByTestId("credit-apply")).toBeNull();
  });

  test("a refusal is rendered as a sentence carrying the balance, never as a code", async () => {
    renderPanel(
      async (_path, init) => {
        if (init?.method === "POST") {
          return json({ code: "INSUFFICIENT_CREDIT", params: { limit: 50_000, actual: 90_000 } }, 422);
        }
        return json(LEDGER);
      },
      { chargeId: "c1" },
    );
    await screen.findByTestId("credit-panel");

    fireEvent.change(screen.getByTestId("credit-apply-amount"), { target: { value: "900" } });
    fireEvent.click(screen.getByTestId("credit-apply"));

    const alert = await screen.findByTestId("credit-refusal");
    expect(alert.textContent).not.toContain("INSUFFICIENT_CREDIT");
    // The limit is money on screen, not a bare integer of minor units.
    expect(alert.textContent).toContain("500");
  });
});
