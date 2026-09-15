// The insurance company registry — Phase 5 PR 1. Clinic configuration, so it lives with settings.

type AuthFetch = (path: string, init?: RequestInit) => Promise<Response>;

export const COMPANY_TYPES = ["INSURER", "TPA", "CORPORATE", "GOVERNMENT"] as const;
export type CompanyType = (typeof COMPANY_TYPES)[number];

export const CLAIM_METHODS = ["PORTAL", "EMAIL", "PAPER", "OTHER"] as const;
export type ClaimMethod = (typeof CLAIM_METHODS)[number];

export interface InsuranceCompany {
  id: string;
  name: string;
  type: CompanyType;
  contractNumber: string | null;
  contractStart: string | null;
  contractEnd: string | null;
  contactPerson: string | null;
  phone: string | null;
  email: string | null;
  claimSubmissionMethod: ClaimMethod | null;
  paymentTermsDays: number | null;
  priorApprovalRequired: boolean;
  isActive: boolean;
}

export type CompanyDraft = Omit<InsuranceCompany, "id">;

/** Anything that is not an array reads as an empty registry rather than breaking the screen. */
export async function loadInsuranceCompanies(authFetch: AuthFetch): Promise<InsuranceCompany[]> {
  const response = await authFetch("/api/insurance-companies?includeInactive=true");
  if (!response.ok) return [];
  const body: unknown = await response.json();
  return Array.isArray(body) ? (body as InsuranceCompany[]) : [];
}

export async function createInsuranceCompany(
  authFetch: AuthFetch,
  draft: CompanyDraft,
): Promise<{ ok: true } | { ok: false; code: string }> {
  const response = await authFetch("/api/insurance-companies", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(draft),
  });
  if (response.ok) return { ok: true };
  // The API answers `{ code, params }` and the client owns the wording — the refusal-codes contract.
  const body: unknown = await response.json().catch(() => null);
  const code =
    typeof body === "object" && body !== null && typeof (body as { code?: unknown }).code === "string"
      ? (body as { code: string }).code
      : "INTERNAL";
  return { ok: false, code };
}

export async function updateInsuranceCompany(
  authFetch: AuthFetch,
  companyId: string,
  patch: Partial<CompanyDraft>,
): Promise<boolean> {
  const response = await authFetch(`/api/insurance-companies/${companyId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
  return response.ok;
}
