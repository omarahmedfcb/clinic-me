// The desk and the «المدفوعات» screen — Phase 5 PR 8 and PR 9, amended by R1 and R2.
// Money is integer minor units on the wire, exactly as it is in the database (CLAUDE.md).

type AuthFetch = (path: string, init?: RequestInit) => Promise<Response>;

export const PAYMENT_METHODS = ["CASH", "CARD", "INSTAPAY", "MOBILE_WALLET", "BANK_TRANSFER"] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export interface ChargeLine {
  id: string;
  nameSnapshot: string;
  unitPriceMinor: number;
  quantity: number;
  source: string;
  /** Set on an ADJUSTMENT line: the doctor who moved the total, and why (R1). */
  adjustedBy: string | null;
  adjustmentReason: string | null;
}

export interface Receipt {
  paymentId: string;
  receiptNumber: number;
  receiptDate: string;
  amountMinor: number;
  method: string;
  collectedBy: string | null;
}

export interface DeskCharge {
  chargeId: string;
  visitId: string;
  patientId: string;
  patientName: string;
  /** Sequential per clinic; the printed invoice carries it. */
  patientFileNumber: number;
  /** `YYYY-MM-DD`: an invoice is dated, not timestamped. */
  issuedOn: string;
  status: string;
  subtotalMinor: number;
  discountMinor: number;
  discountReason: string | null;
  payerShareMinor: number;
  patientShareMinor: number;
  paidMinor: number;
  balanceMinor: number;
  discountCeilingMinor: number | null;
  lines: ChargeLine[];
  receipts: Receipt[];
}

export interface PayerSplit {
  chargeId: string;
  subtotalMinor: number;
  discountMinor: number;
  payerShareMinor: number;
  patientShareMinor: number;
  payerName: string | null;
}

/** The API answers `{ code, params }` and the client owns the wording — the refusal contract. */
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

export async function loadCharge(authFetch: AuthFetch, chargeId: string): Promise<DeskCharge | null> {
  const response = await authFetch(`/api/charges/${chargeId}`);
  return response.ok ? ((await response.json()) as DeskCharge) : null;
}

export async function applyDiscount(
  authFetch: AuthFetch,
  chargeId: string,
  discountMinor: number,
  reason: string,
): Promise<{ ok: true; charge: DeskCharge } | Refused> {
  const response = await authFetch(`/api/charges/${chargeId}/discount`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ discountMinor, reason }),
  });
  return response.ok ? { ok: true, charge: (await response.json()) as DeskCharge } : refusal(response);
}

export async function loadSplit(authFetch: AuthFetch, chargeId: string): Promise<PayerSplit | null> {
  const response = await authFetch(`/api/charges/${chargeId}/split`);
  return response.ok ? ((await response.json()) as PayerSplit) : null;
}

export async function setPayerShare(
  authFetch: AuthFetch,
  chargeId: string,
  payerShareMinor: number,
): Promise<{ ok: true; split: PayerSplit } | Refused> {
  const response = await authFetch(`/api/charges/${chargeId}/split`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ payerShareMinor }),
  });
  return response.ok ? { ok: true, split: (await response.json()) as PayerSplit } : refusal(response);
}

/**
 * Records money handed over.
 *
 * `chargeId` may be null — Q19: a payment can arrive before the invoice exists, and it settles the
 * charge when the visit completes. The desk sends what it has.
 */
export async function recordPayment(
  authFetch: AuthFetch,
  input: {
    chargeId: string | null;
    patientId: string;
    appointmentId: string | null;
    amountMinor: number;
    method: PaymentMethod;
  },
): Promise<{ ok: true; receipt: Receipt } | Refused> {
  const response = await authFetch("/api/payments", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  return response.ok ? { ok: true, receipt: (await response.json()) as Receipt } : refusal(response);
}

/** R2's screen, in one call. What each role does with it is the screen's business, not the wire's. */
export interface PaymentsOverview {
  day: string;
  byMethod: { method: string; totalMinor: number }[];
  collectedTodayMinor: number;
  outstandingMinor: number;
  charges: {
    chargeId: string;
    visitId: string;
    patientId: string;
    patientName: string;
    doctorName: string;
    status: string;
    subtotalMinor: number;
    discountMinor: number;
    paidMinor: number;
    balanceMinor: number;
    today: boolean;
  }[];
  receipts: {
    paymentId: string;
    receiptNumber: number;
    patientName: string;
    amountMinor: number;
    method: string;
    collectedBy: string | null;
  }[];
  adjustments: {
    visitId: string;
    patientName: string;
    doctorName: string;
    amountMinor: number;
    reason: string | null;
    at: string;
  }[];
  aboveCeiling: {
    chargeId: string;
    patientName: string;
    discountMinor: number;
    reason: string | null;
    authorisedBy: string | null;
  }[];
  mayCollect: boolean;
}

export async function loadPaymentsOverview(authFetch: AuthFetch): Promise<PaymentsOverview | null> {
  const response = await authFetch("/api/payments/overview");
  return response.ok ? ((await response.json()) as PaymentsOverview) : null;
}
