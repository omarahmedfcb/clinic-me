// The insurance company registry, on the settings screen — Phase 5 PR 1.
// No coverage percentage and no copay: the payer split is manual until real policies are seen.

import { useCallback, useEffect, useState } from "react";
import { Button } from "../../design-system/Button.tsx";
import { Card } from "../../design-system/display.tsx";
import { Select, TextInput } from "../../design-system/fields.tsx";
import { useLocale } from "../../i18n/locale-context.tsx";
import type { TranslationKey } from "../../i18n/strings.ts";
import {
  CLAIM_METHODS,
  COMPANY_TYPES,
  createInsuranceCompany,
  loadInsuranceCompanies,
  updateInsuranceCompany,
  type ClaimMethod,
  type CompanyDraft,
  type CompanyType,
  type InsuranceCompany,
} from "./insurance-companies-api.ts";

type AuthFetch = (path: string, init?: RequestInit) => Promise<Response>;

const EMPTY: CompanyDraft = {
  name: "",
  type: "INSURER",
  contractNumber: null,
  contractStart: null,
  contractEnd: null,
  contactPerson: null,
  phone: null,
  email: null,
  claimSubmissionMethod: null,
  paymentTermsDays: null,
  priorApprovalRequired: false,
  isActive: true,
};

/** Blank means absent, never an empty string — the API reads `null` as "not recorded". */
const orNull = (value: string): string | null => (value.trim() === "" ? null : value.trim());

export function InsuranceCompaniesCard({ authFetch }: { authFetch: AuthFetch }) {
  const { t } = useLocale();
  const [companies, setCompanies] = useState<InsuranceCompany[]>([]);
  const [draft, setDraft] = useState<CompanyDraft>(EMPTY);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setCompanies(await loadInsuranceCompanies(authFetch));
  }, [authFetch]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function save(): Promise<void> {
    setBusy(true);
    setFailure(null);
    const result = await createInsuranceCompany(authFetch, draft);
    setBusy(false);
    if (!result.ok) {
      setFailure(result.code);
      return;
    }
    setDraft(EMPTY);
    setOpen(false);
    await refresh();
  }

  async function toggleActive(company: InsuranceCompany): Promise<void> {
    setBusy(true);
    // Deactivation, never deletion: a company with policies against it must stay readable, and the
    // list reception picks from is filtered on the server rather than by removing the row.
    const ok = await updateInsuranceCompany(authFetch, company.id, { isActive: !company.isActive });
    setBusy(false);
    if (!ok) {
      setFailure("INTERNAL");
      return;
    }
    await refresh();
  }

  return (
    <Card title={t("settings.insurers.title")} subtitle={t("settings.insurers.subtitle")}>
      {failure !== null && (
        <p role="alert" className="mb-3 text-xs text-danger" data-testid="insurer-failure">
          {t(`refusal.${failure}` as TranslationKey)}
        </p>
      )}

      {companies.length === 0 ? (
        <p className="text-sm text-ink-subtle">{t("settings.insurers.none")}</p>
      ) : (
        <ul className="flex flex-col gap-2" data-testid="insurer-list">
          {companies.map((company) => (
            <li
              key={company.id}
              data-testid={`insurer-${company.id}`}
              className="flex items-center justify-between gap-3 rounded border border-border p-2"
            >
              <div className="min-w-0">
                <span className="block text-sm text-ink">{company.name}</span>
                <span className="block text-xs text-ink-subtle">
                  {t(`settings.insurers.type.${company.type}` as TranslationKey)}
                  {company.paymentTermsDays !== null && (
                    <span className="ms-2 numeric">
                      {t("settings.insurers.terms").replace("{days}", String(company.paymentTermsDays))}
                    </span>
                  )}
                  {company.priorApprovalRequired && (
                    <span className="ms-2 text-warning">{t("settings.insurers.priorApproval")}</span>
                  )}
                  {!company.isActive && (
                    <span className="ms-2 text-ink-muted">{t("settings.insurers.inactive")}</span>
                  )}
                </span>
              </div>
              <Button
                size="sm"
                variant="secondary"
                loading={busy}
                data-testid={`toggle-${company.id}`}
                onClick={() => void toggleActive(company)}
              >
                {company.isActive ? t("settings.insurers.deactivate") : t("settings.insurers.activate")}
              </Button>
            </li>
          ))}
        </ul>
      )}

      {!open ? (
        <div className="mt-3">
          <Button size="sm" data-testid="add-insurer" onClick={() => setOpen(true)}>
            {t("settings.insurers.add")}
          </Button>
        </div>
      ) : (
        <div className="mt-3 grid gap-3 rounded-lg border border-border p-3" data-testid="insurer-form">
          <div className="grid gap-3 sm:grid-cols-2">
            <TextInput
              label={t("settings.insurers.name")}
              required
              value={draft.name}
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
            />
            <Select
              label={t("settings.insurers.type")}
              value={draft.type}
              options={COMPANY_TYPES.map((value) => ({
                value,
                label: t(`settings.insurers.type.${value}` as TranslationKey),
              }))}
              onChange={(event) => setDraft({ ...draft, type: event.target.value as CompanyType })}
            />
            <TextInput
              label={t("settings.insurers.contractNumber")}
              value={draft.contractNumber ?? ""}
              onChange={(event) => setDraft({ ...draft, contractNumber: orNull(event.target.value) })}
            />
            <TextInput
              label={t("settings.insurers.contactPerson")}
              value={draft.contactPerson ?? ""}
              onChange={(event) => setDraft({ ...draft, contactPerson: orNull(event.target.value) })}
            />
            <TextInput
              label={t("settings.insurers.contractStart")}
              type="date"
              numeric
              value={draft.contractStart ?? ""}
              onChange={(event) => setDraft({ ...draft, contractStart: orNull(event.target.value) })}
            />
            <TextInput
              label={t("settings.insurers.contractEnd")}
              type="date"
              numeric
              value={draft.contractEnd ?? ""}
              onChange={(event) => setDraft({ ...draft, contractEnd: orNull(event.target.value) })}
            />
            <TextInput
              label={t("settings.insurers.phone")}
              numeric
              value={draft.phone ?? ""}
              onChange={(event) => setDraft({ ...draft, phone: orNull(event.target.value) })}
            />
            <TextInput
              label={t("settings.insurers.email")}
              value={draft.email ?? ""}
              onChange={(event) => setDraft({ ...draft, email: orNull(event.target.value) })}
            />
            <Select
              label={t("settings.insurers.claimMethod")}
              value={draft.claimSubmissionMethod ?? ""}
              placeholder={t("settings.insurers.claimMethod")}
              options={CLAIM_METHODS.map((value) => ({
                value,
                label: t(`settings.insurers.claim.${value}` as TranslationKey),
              }))}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  claimSubmissionMethod: (event.target.value || null) as ClaimMethod | null,
                })
              }
            />
            <TextInput
              label={t("settings.insurers.paymentTerms")}
              type="number"
              numeric
              min={0}
              max={365}
              value={draft.paymentTermsDays === null ? "" : String(draft.paymentTermsDays)}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  // `Number("")` is 0, and zero payment terms is a real value meaning "on
                  // presentation" — so blank is decided before the parse, never by it.
                  paymentTermsDays: event.target.value === "" ? null : Number(event.target.value),
                })
              }
            />
          </div>

          <label className="flex items-center gap-2 text-sm text-ink">
            <input
              type="checkbox"
              data-testid="prior-approval"
              checked={draft.priorApprovalRequired}
              onChange={(event) => setDraft({ ...draft, priorApprovalRequired: event.target.checked })}
            />
            {t("settings.insurers.priorApprovalLabel")}
          </label>

          <div className="flex gap-2">
            <Button
              size="sm"
              disabled={draft.name.trim() === ""}
              loading={busy}
              data-testid="save-insurer"
              onClick={() => void save()}
            >
              {t("settings.save")}
            </Button>
            <Button size="sm" variant="secondary" onClick={() => setOpen(false)}>
              {t("doctors.cancel")}
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}
