// What the visit costs, and the doctor's signed adjustment to it — R1. Money is minor units.

type AuthFetch = (path: string, init?: RequestInit) => Promise<Response>;

export interface VisitPricing {
  subtotalMinor: number;
  /** Signed. Negative lowers the total. Null when nothing has been adjusted. */
  adjustmentMinor: number | null;
  adjustmentReason: string | null;
  adjustedAt: string | null;
  totalMinor: number;
  /** False hides the control entirely; the route refuses regardless. */
  mayAdjust: boolean;
  /** How far this doctor may move the total, against this visit. Null means unlimited. */
  capMinor: number | null;
}

export const NO_PRICING: VisitPricing = {
  subtotalMinor: 0,
  adjustmentMinor: null,
  adjustmentReason: null,
  adjustedAt: null,
  totalMinor: 0,
  mayAdjust: false,
  capMinor: null,
};

// The paths are written out at both call sites rather than built by a helper, so the
// route-capability manifest can read them.

export async function loadVisitPricing(
  authFetch: AuthFetch,
  appointmentId: string,
  visitId: string,
): Promise<VisitPricing> {
  const response = await authFetch(`/api/appointments/${appointmentId}/visit/${visitId}/pricing`);
  if (!response.ok) return NO_PRICING;
  const body: unknown = await response.json();
  return typeof body === "object" && body !== null ? { ...NO_PRICING, ...body } : NO_PRICING;
}

/**
 * The refusal is returned rather than flattened to null.
 *
 * The cap refusal carries the limit, and a screen that renders "could not save" instead has told
 * the doctor nothing they can act on — the rule `REFUSAL-CODES.md` exists for.
 */
export type SaveResult =
  | { ok: true; pricing: VisitPricing }
  | { ok: false; code: string; params: Record<string, unknown> };

export async function saveVisitAdjustment(
  authFetch: AuthFetch,
  appointmentId: string,
  visitId: string,
  input: { adjustmentMinor: number | null; reason: string | null },
): Promise<SaveResult> {
  const response = await authFetch(`/api/appointments/${appointmentId}/visit/${visitId}/pricing`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (response.ok) return { ok: true, pricing: (await response.json()) as VisitPricing };

  const body: unknown = await response.json().catch(() => null);
  const shape = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  return {
    ok: false,
    code: typeof shape["code"] === "string" ? (shape["code"] as string) : "INTERNAL",
    params: (shape["params"] as Record<string, unknown>) ?? {},
  };
}
