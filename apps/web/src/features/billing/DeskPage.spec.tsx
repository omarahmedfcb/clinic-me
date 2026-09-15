import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { LocaleProvider } from "../../i18n/locale-context.tsx";
import { DeskPage } from "./DeskPage.tsx";

/**
 * The desk — Phase 5 PR 9, amended by the founder's review of #99.
 *
 * The backend guards live in `desk.integration.spec.ts`; these are about what the screen does with
 * the answer. Four of them carry the review's findings:
 *
 *   - **money is typed in EGP and sent in minor units** — `50` means fifty pounds, not fifty piastres;
 *   - the collection box is **prefilled with what is left to pay** and refuses more than that;
 *   - the insurer section **offers nothing when the patient has no policy**;
 *   - a refusal is rendered as a sentence with its numbers in it, not as a code.
 */

const CHARGE = {
  chargeId: "c1",
  visitId: "v1",
  patientId: "p1",
  patientName: "مريم حسن",
  patientFileNumber: 42,
  issuedOn: "2026-09-11",
  status: "OPEN",
  subtotalMinor: 100_000,
  discountMinor: 0,
  discountReason: null,
  payerShareMinor: 0,
  patientShareMinor: 100_000,
  paidMinor: 0,
  balanceMinor: 100_000,
  discountCeilingMinor: 5_000,
  lines: [
    {
      id: "l1",
      nameSnapshot: "كشف جديد",
      unitPriceMinor: 100_000,
      quantity: 1,
      source: "CATALOGUE",
      adjustedBy: null,
      adjustmentReason: null,
    },
  ],
  receipts: [],
};

const NO_COVER = { chargeId: "c1", payerName: null, payerShareMinor: 0 };

const EMPTY_CREDIT = {
  patientId: "p1",
  balanceMinor: 0,
  creditedMinor: 0,
  appliedMinor: 0,
  refundedMinor: 0,
  movements: [],
};
const COVERED = { chargeId: "c1", payerName: "مصر للتأمين", payerShareMinor: 0 };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function renderDesk(
  inner: (path: string, init?: RequestInit) => Promise<Response>,
  split: unknown = NO_COVER,
) {
  const authFetch = vi.fn(async (path: string, init?: RequestInit) => {
    if (path.includes("/split")) return json(split);
    if (path.includes("/clinic-identity")) return json({ name: "عيادة", hasLogo: false });
    // The credit panel reads this on every desk render. An empty ledger by default, so these tests
    // stay about the bill; the credit tests below supply their own.
    if (path.includes("/credit")) return json(EMPTY_CREDIT);
    return inner(path, init);
  });
  render(
    <LocaleProvider>
      <DeskPage authFetch={authFetch} chargeId="c1" currency="EGP" />
    </LocaleProvider>,
  );
  return authFetch;
}

/** The typed text of a money box, which is always major units. */
const box = (testId: string): HTMLInputElement => screen.getByTestId(testId) as HTMLInputElement;

afterEach(cleanup);

describe("the desk", () => {
  test("shows the lines and the balance", async () => {
    renderDesk(async () => json(CHARGE));
    await screen.findByTestId("charge-lines");
    expect(screen.getByTestId("balance").textContent).toContain("1,000");
  });

  test("tells reception what it may discount before it tries", async () => {
    renderDesk(async () => json(CHARGE));
    const hint = await screen.findByTestId("ceiling-hint");
    // The ceiling is a number a receptionist can act on; a screen that only refuses afterwards
    // makes them guess.
    expect(hint.textContent).toContain("50");
  });

  test("a ceiling refusal is rendered as a sentence carrying the limit", async () => {
    renderDesk(async (path, init) => {
      if (init?.method === "PUT" && path.includes("/discount")) {
        return json({ code: "DISCOUNT_ABOVE_CEILING", params: { limit: 5_000, actual: 20_000 } }, 403);
      }
      return json(CHARGE);
    });
    await screen.findByTestId("apply-discount");

    fireEvent.change(box("discount-amount"), { target: { value: "200" } });
    fireEvent.change(screen.getByLabelText(/سبب الخصم|Reason/), { target: { value: "goodwill" } });
    fireEvent.click(screen.getByTestId("apply-discount"));

    const alert = await screen.findByTestId("desk-failure");
    // Never the bare code, and the limit is interpolated as money rather than left as `{limit}`.
    expect(alert.textContent).not.toContain("DISCOUNT_ABOVE_CEILING");
    expect(alert.textContent).not.toContain("{limit}");
    expect(alert.textContent).toContain("50");
  });

  test("a discount typed in pounds is sent in minor units", async () => {
    // **The defect this test exists for.** The box used to send its own text through as minor
    // units, so a receptionist typing 50 applied a discount of half a pound and nothing failed.
    const authFetch = renderDesk(async (path, init) => {
      if (init?.method === "PUT" && path.includes("/discount")) return json(CHARGE);
      return json(CHARGE);
    });
    await screen.findByTestId("apply-discount");

    fireEvent.change(box("discount-amount"), { target: { value: "50" } });
    fireEvent.change(screen.getByLabelText(/سبب الخصم|Reason/), { target: { value: "goodwill" } });
    fireEvent.click(screen.getByTestId("apply-discount"));

    await waitFor(() => {
      const put = authFetch.mock.calls.find(([path, init]) => init?.method === "PUT" && path.includes("/discount"));
      expect(put).toBeDefined();
      const body = JSON.parse((put as [string, RequestInit])[1].body as string) as Record<string, unknown>;
      expect(body).toMatchObject({ discountMinor: 5_000 });
    });
  });

  test("a discount is shown as a deduction, signed by the formatter", async () => {
    renderDesk(async () => json({ ...CHARGE, discountMinor: 5_000, patientShareMinor: 95_000, balanceMinor: 95_000 }));
    const row = await screen.findByTestId("discount-row");
    // `Intl` emits an LRM immediately before its own minus so the sign stays inside the number's
    // left-to-right run. A hand-written `−` sits outside it and detaches in an Arabic paragraph.
    expect(row.textContent).toContain("‎-");
    expect(row.textContent).not.toMatch(/^−/);
  });

  test("the collection box is prefilled with what is still owed", async () => {
    renderDesk(async () => json({ ...CHARGE, paidMinor: 40_000, balanceMinor: 60_000 }));
    await screen.findByTestId("record-payment");
    // 60,000 minor units is 600 pounds, and the box holds pounds.
    expect(box("payment-amount").value).toBe("600");
    expect(screen.getByTestId("due-hint").textContent).toContain("600");
  });

  /**
   * **R-A restored the refusal ruling 5 had removed**, 2026-09-14. The server answers 422; the
   * button refuses first so a receptionist learns it before the patient is told a total.
   */
  test("more than the remaining balance is refused by the button, before the round trip", async () => {
    const authFetch = renderDesk(async () => json({ ...CHARGE, paidMinor: 40_000, balanceMinor: 60_000 }));
    await screen.findByTestId("record-payment");

    fireEvent.change(box("payment-amount"), { target: { value: "900" } });
    expect(screen.getByTestId("over-balance").textContent?.length ?? 0).toBeGreaterThan(5);
    expect(screen.getByTestId("record-payment")).toHaveProperty("disabled", true);

    // A part-payment is the ordinary case and stays allowed.
    fireEvent.change(box("payment-amount"), { target: { value: "200" } });
    expect(screen.queryByTestId("over-balance")).toBeNull();
    fireEvent.click(screen.getByTestId("record-payment"));
    await waitFor(() => {
      const post = authFetch.mock.calls.find(([path, init]) => path === "/api/payments" && init?.method === "POST");
      expect(post).toBeDefined();
      const body = JSON.parse((post as [string, RequestInit])[1].body as string) as Record<string, unknown>;
      expect(body).toMatchObject({ amountMinor: 20_000 });
    });
  });

  test("a patient with no cover is offered no split, and told why", async () => {
    renderDesk(async () => json(CHARGE), NO_COVER);
    await screen.findByTestId("no-cover");
    // No input on an impossible action: a box that can only ever be refused reads as a thing the
    // clinic could have done and did not.
    expect(screen.queryByTestId("payer-share-amount")).toBeNull();
    expect(screen.queryByTestId("set-split")).toBeNull();
  });

  test("a covered patient can be split by amount or by percentage", async () => {
    const authFetch = renderDesk(async () => json(CHARGE), COVERED);
    await screen.findByTestId("payer-share-amount");

    fireEvent.click(screen.getByTestId("share-mode-PERCENT"));
    fireEvent.change(screen.getByTestId("payer-share-percent"), { target: { value: "80" } });
    // The screen does the arithmetic and shows it before anyone commits to it.
    expect(screen.getByTestId("percent-preview").textContent).toContain("800");

    fireEvent.click(screen.getByTestId("set-split"));
    await waitFor(() => {
      const put = authFetch.mock.calls.find(([path, init]) => init?.method === "PUT" && path.includes("/split"));
      expect(put).toBeDefined();
      const body = JSON.parse((put as [string, RequestInit])[1].body as string) as Record<string, unknown>;
      // 80% of 100,000 minor units. The wire carries money, never a rate.
      expect(body).toEqual({ payerShareMinor: 80_000 });
    });
  });

  test("recording a payment sends the amount and method, then prints a receipt", async () => {
    const authFetch = renderDesk(async (path, init) => {
      if (init?.method === "POST" && path === "/api/payments") {
        return json({
          paymentId: "pay1",
          receiptNumber: 41,
          receiptDate: "2026-09-11",
          amountMinor: 40_000,
          method: "CASH",
          collectedBy: "شيماء",
        });
      }
      return json(CHARGE);
    });
    await screen.findByTestId("record-payment");

    fireEvent.change(box("payment-amount"), { target: { value: "400" } });
    fireEvent.click(screen.getByTestId("record-payment"));

    await waitFor(() => {
      const post = authFetch.mock.calls.find(([path, init]) => path === "/api/payments" && init?.method === "POST");
      expect(post).toBeDefined();
      const body = JSON.parse((post as [string, RequestInit])[1].body as string) as Record<string, unknown>;
      expect(body).toMatchObject({ amountMinor: 40_000, method: "CASH", chargeId: "c1" });
    });

    // The sheet is printed straight away: a receipt the patient has to ask for is one half of them
    // leave without.
    const root = await screen.findByTestId("print-root");
    expect(root.textContent).toContain("RECEIPT");
  });

  test("the receipt sheet is English and left-to-right, whatever the interface is", async () => {
    renderDesk(async (path, init) => {
      if (init?.method === "POST" && path === "/api/payments") {
        return json({
          paymentId: "pay1",
          receiptNumber: 41,
          receiptDate: "2026-09-11",
          amountMinor: 40_000,
          method: "CASH",
          collectedBy: null,
        });
      }
      return json(CHARGE);
    });
    await screen.findByTestId("record-payment");
    fireEvent.change(box("payment-amount"), { target: { value: "400" } });
    fireEvent.click(screen.getByTestId("record-payment"));

    await screen.findByTestId("print-root");
    const sheet = document.querySelector(".print-sheet");
    expect(sheet).not.toBeNull();
    // Q45 applies to every printed sheet, and this is one.
    expect({ dir: sheet?.getAttribute("dir"), lang: sheet?.getAttribute("lang") }).toEqual({
      dir: "ltr",
      lang: "en",
    });
    expect(sheet?.textContent).toContain("Receipt No.");
    expect(sheet?.textContent).toContain("41");
  });

  test("the invoice prints the charge as a document, separately from any receipt", async () => {
    renderDesk(async () => json({ ...CHARGE, discountMinor: 5_000, patientShareMinor: 95_000, balanceMinor: 95_000 }));
    fireEvent.click(await screen.findByTestId("print-invoice"));

    await screen.findByTestId("print-root");
    const sheet = document.querySelector(".print-sheet");
    expect({ dir: sheet?.getAttribute("dir"), lang: sheet?.getAttribute("lang") }).toEqual({
      dir: "ltr",
      lang: "en",
    });
    const text = sheet?.textContent ?? "";
    expect(text).toContain("INVOICE");
    // The invoice number is the charge id, and the file number is how the record is found again.
    expect(text).toContain("c1");
    expect(text).toContain("42");
    for (const line of ["Subtotal", "Discount", "Patient owes", "Paid", "Remaining"]) {
      expect(text).toContain(line);
    }
  });
});
