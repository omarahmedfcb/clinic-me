// «تقارير المدفوعات» — Phase 5 PR 14. Read-only; there is no write call in this file by design.
// Mirrors `apps/api/src/modules/billing/payments-report.ts`.

type AuthFetch = (path: string, init?: RequestInit) => Promise<Response>;

export type ReportPeriod = "DAY" | "MONTH";

export interface DoctorTotals {
  doctorId: string;
  doctorName: string;
  collectedMinor: number;
  chargedMinor: number;
  outstandingMinor: number;
  charges: number;
}

export interface PaymentsReport {
  period: ReportPeriod;
  on: string;
  from: string;
  to: string;
  collectedMinor: number;
  byMethod: { method: string; totalMinor: number }[];
  byDoctor: DoctorTotals[];
  outstandingMinor: number;
  outstanding: {
    chargeId: string;
    patientName: string;
    doctorName: string;
    issuedOn: string;
    balanceMinor: number;
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
    doctorName: string;
    discountMinor: number;
    reason: string | null;
    authorisedBy: string | null;
  }[];
  /** Whose figures these are. A doctor is told, because a total that looks clinic-wide and is not
   *  is the kind of number somebody makes a decision on. */
  scope: "CLINIC" | "OWN";
}

/** Throws rather than answering with zeros: a failed read is not a day on which nothing happened. */
export async function loadPaymentsReport(
  authFetch: AuthFetch,
  query: { period: ReportPeriod; on?: string },
): Promise<PaymentsReport> {
  const params = new URLSearchParams({ period: query.period });
  if (query.on !== undefined && query.on !== "") params.set("on", query.on);

  const response = await authFetch(`/api/reports/payments?${params.toString()}`);
  if (!response.ok) throw new Error(`GET /reports/payments -> ${response.status}`);

  const body = (await response.json()) as Partial<PaymentsReport>;
  if (typeof body.collectedMinor !== "number" || !Array.isArray(body.byDoctor)) {
    throw new Error("GET /reports/payments -> unreadable payload");
  }
  return body as PaymentsReport;
}
