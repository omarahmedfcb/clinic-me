// Clinic credit — ruling 5. The ledger the patient card and the desk both read.
// Literal paths, one function each: the route manifest reads client call sites as literals.

type AuthFetch = (path: string, init?: RequestInit) => Promise<Response>;

/** The codes the server writes into `reason` for a credit it raised itself — R-A's three origins. */
export const CREDIT_ORIGINS = [
  "PRE_PAYMENT_ABOVE_BILL",
  "APPOINTMENT_CANCELLED",
  "APPOINTMENT_NOT_ATTENDED",
] as const;

export interface CreditMovement {
  id: string;
  movement: "CREDIT" | "APPLIED" | "REFUNDED";
  amountMinor: number;
  reason: string | null;
  actorName: string;
  /** The receipt this credit came from, when it came from one. */
  receiptNumber: number | null;
  appliedChargeId: string | null;
  at: string;
}

export interface CreditLedger {
  patientId: string;
  balanceMinor: number;
  creditedMinor: number;
  appliedMinor: number;
  refundedMinor: number;
  movements: CreditMovement[];
}

type Refused = { ok: false; code: string; params: Record<string, unknown> };

async function refusal(response: Response): Promise<Refused> {
  const body: unknown = await response.json().catch(() => null);
  const shape = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  return {
    ok: false,
    code: typeof shape["code"] === "string" ? (shape["code"] as string) : "INTERNAL",
    params: (shape["params"] as Record<string, unknown>) ?? {},
  };
}

/**
 * Throws rather than answering with an empty ledger: a refused read is not a zero balance, and money
 * is the worst place to say "nothing here" when what is known is "could not say".
 *
 * The shape is checked for the same reason. A payload without the fields is not a patient with no
 * credit — it is a reply this screen cannot read, and rendering a confident zero from it would be
 * the same lie by a shorter route.
 */
export async function loadCredit(authFetch: AuthFetch, patientId: string): Promise<CreditLedger> {
  const response = await authFetch(`/api/patients/${patientId}/credit`);
  if (!response.ok) throw new Error(`GET /patients/:id/credit -> ${response.status}`);

  const body = (await response.json()) as Partial<CreditLedger>;
  if (typeof body.balanceMinor !== "number" || !Array.isArray(body.movements)) {
    throw new Error("GET /patients/:id/credit -> unreadable payload");
  }
  return body as CreditLedger;
}

export async function applyCredit(
  authFetch: AuthFetch,
  chargeId: string,
  amountMinor: number,
): Promise<{ ok: true; balanceMinor: number } | Refused> {
  const response = await authFetch(`/api/charges/${chargeId}/credit`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ amountMinor }),
  });
  if (!response.ok) return refusal(response);
  const body = (await response.json()) as { balanceMinor: number };
  return { ok: true, balanceMinor: body.balanceMinor };
}

export async function refundCredit(
  authFetch: AuthFetch,
  patientId: string,
  input: { amountMinor: number; reason: string },
): Promise<{ ok: true; balanceMinor: number } | Refused> {
  const response = await authFetch(`/api/patients/${patientId}/credit/refund`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!response.ok) return refusal(response);
  const body = (await response.json()) as { balanceMinor: number };
  return { ok: true, balanceMinor: body.balanceMinor };
}
