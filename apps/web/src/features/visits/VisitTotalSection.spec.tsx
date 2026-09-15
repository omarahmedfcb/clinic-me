import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { LocaleProvider } from "../../i18n/locale-context.tsx";
import { VisitTotalSection } from "./VisitTotalSection.tsx";

/**
 * The visit total and R1's adjustment control.
 *
 * **The guard: a doctor without the clinic's permission gets no control at all.** The route refuses
 * one regardless — `payments-and-pricing.integration.spec.ts` proves that — so this is about the
 * screen not offering an act that would be refused.
 */

const PRICING = {
  subtotalMinor: 100_000,
  adjustmentMinor: null,
  adjustmentReason: null,
  adjustedAt: null,
  totalMinor: 100_000,
  mayAdjust: true,
  capMinor: null,
};

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

function renderSection(pricing: unknown, onPut?: (body: unknown) => unknown) {
  const authFetch = vi.fn(async (_path: string, init?: RequestInit) => {
    if (init?.method === "PUT") {
      const body: unknown = JSON.parse(init.body as string);
      return json(onPut === undefined ? pricing : onPut(body));
    }
    return json(pricing);
  });
  render(
    <LocaleProvider>
      <VisitTotalSection authFetch={authFetch} appointmentId="a1" visitId="v1" currency="EGP" />
    </LocaleProvider>,
  );
  return authFetch;
}

afterEach(cleanup);

describe("the visit total", () => {
  test("shows what the visit will cost before it is finished", async () => {
    renderSection(PRICING);
    const total = await screen.findByTestId("visit-total-amount");
    expect(total.textContent).toContain("1,000");
  });

  test("a doctor the clinic has not allowed sees the total and no control", async () => {
    renderSection({ ...PRICING, mayAdjust: false });
    await screen.findByTestId("visit-total-amount");
    expect(screen.queryByTestId("save-adjustment")).toBeNull();
  });

  test("an allowed doctor sends a signed amount, and zero is not offered", async () => {
    const authFetch = renderSection(PRICING, (body) => ({
      ...PRICING,
      ...(body as Record<string, unknown>),
      adjustmentMinor: -20_000,
      totalMinor: 80_000,
    }));
    await screen.findByTestId("save-adjustment");

    // Zero is not an adjustment — the database refuses one, so the button does too.
    fireEvent.change(screen.getByTestId("adjustment-amount"), { target: { value: "0" } });
    expect(screen.getByTestId("save-adjustment")).toHaveProperty("disabled", true);

    // **Typed in pounds, sent in minor units.** The box used to send its own text through, so a
    // doctor writing 200 moved the total by two pounds and nothing failed.
    fireEvent.change(screen.getByTestId("adjustment-amount"), { target: { value: "-200" } });
    fireEvent.click(screen.getByTestId("save-adjustment"));

    await waitFor(() => {
      const put = authFetch.mock.calls.find(([, init]) => init?.method === "PUT");
      expect(put).toBeDefined();
      const body = JSON.parse((put as [string, RequestInit])[1].body as string) as Record<string, unknown>;
      expect(body).toMatchObject({ adjustmentMinor: -20_000 });
    });

    // The total the doctor is about to bill moves with it, rather than only after completion.
    await waitFor(() => expect(screen.getByTestId("visit-total-amount").textContent).toContain("800"));
  });
});

describe("the cap on the pricing permission (R1 as amended)", () => {
  test("the limit is named before it is hit, not only when it is", async () => {
    renderSection({ ...PRICING, capMinor: 10_000 });
    const hint = await screen.findByTestId("cap-hint");
    // The same courtesy the desk's ceiling hint gives reception: a limit you only learn by being
    // refused makes people guess.
    expect(hint.textContent).toContain("100");
  });

  test("no cap means no sentence about one", async () => {
    renderSection(PRICING);
    await screen.findByTestId("visit-total-amount");
    expect(screen.queryByTestId("cap-hint")).toBeNull();
  });

  test("a refusal above the cap is rendered as a sentence carrying the limit", async () => {
    const authFetch = vi.fn(async (_path: string, init?: RequestInit) => {
      if (init?.method === "PUT") {
        return new Response(
          JSON.stringify({ code: "PRICE_ADJUSTMENT_ABOVE_CAP", params: { limit: 10_000, actual: 20_000 } }),
          { status: 403, headers: { "content-type": "application/json" } },
        );
      }
      return json({ ...PRICING, capMinor: 10_000 });
    });
    render(
      <LocaleProvider>
        <VisitTotalSection authFetch={authFetch} appointmentId="a1" visitId="v1" currency="EGP" />
      </LocaleProvider>,
    );
    await screen.findByTestId("save-adjustment");

    fireEvent.change(screen.getByTestId("adjustment-amount"), { target: { value: "-200" } });
    fireEvent.click(screen.getByTestId("save-adjustment"));

    const alert = await screen.findByTestId("visit-total-failed");
    // Never the bare code, and never a generic "could not save" — the limit is what the doctor
    // needs in order to do something different.
    expect(alert.textContent).not.toContain("PRICE_ADJUSTMENT_ABOVE_CAP");
    expect(alert.textContent).not.toContain("{limit}");
    expect(alert.textContent).toContain("100");
  });
});
