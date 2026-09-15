// Reception attaching a policy — Q42. `POST /patients/:id/insurance` has existed since Phase 3 Q18
// and nothing in the client called it, so cover could be read and never recorded.

import { useEffect, useState } from "react";
import { Button } from "../../design-system/Button.tsx";
import { Select, TextInput } from "../../design-system/fields.tsx";
import { useLocale } from "../../i18n/locale-context.tsx";
import type { TranslationKey } from "../../i18n/strings.ts";
import { addCoverage, loadSelectableInsurers } from "./patients-api.ts";

type AuthFetch = (path: string, init?: RequestInit) => Promise<Response>;

/** Mirrors `RELATIONSHIPS` on the API's `RecordCoverageDto`; the server refuses anything else. */
const RELATIONSHIPS = ["SELF", "SPOUSE", "CHILD", "PARENT", "SIBLING", "OTHER"] as const;

export function AddCoverageForm({
  authFetch,
  patientId,
  onAdded,
}: {
  authFetch: AuthFetch;
  patientId: string;
  onAdded: () => void;
}) {
  const { t } = useLocale();
  const [open, setOpen] = useState(false);
  const [insurerName, setInsurerName] = useState("");
  const [companyId, setCompanyId] = useState("");
  const [planName, setPlanName] = useState("");
  const [isPrimary, setIsPrimary] = useState(false);
  const [companies, setCompanies] = useState<{ id: string; name: string }[]>([]);
  const [policyNumber, setPolicyNumber] = useState("");
  const [policyholderName, setPolicyholderName] = useState("");
  const [validFrom, setValidFrom] = useState("");
  const [validTo, setValidTo] = useState("");
  const [relationship, setRelationship] = useState<string>("SELF");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  // Phase 5 PR 1: the registry reception picks from. A clinic that has not filled it still records
  // cover by typing the insurer name, which is why the select does not replace the text field.
  useEffect(() => {
    let cancelled = false;
    void loadSelectableInsurers(authFetch).then((value) => {
      if (!cancelled) setCompanies(value);
    });
    return () => {
      cancelled = true;
    };
  }, [authFetch]);

  const ready =
    insurerName.trim() !== "" &&
    policyNumber.trim() !== "" &&
    policyholderName.trim() !== "" &&
    validFrom !== "";

  async function submit(): Promise<void> {
    setBusy(true);
    setFailed(false);
    const ok = await addCoverage(authFetch, patientId, {
      insurerName,
      companyId: companyId === "" ? null : companyId,
      planName: planName.trim() === "" ? null : planName.trim(),
      isPrimary,
      policyNumber,
      policyholderName,
      validFrom,
      // Empty means open-ended, which is a real state: several Egyptian corporate schemes renew
      // silently and the desk is never told an end date. `null` must read as neither expired nor
      // unknown, which is why it is sent rather than omitted.
      validTo: validTo === "" ? null : validTo,
      relationshipToPolicyholder: relationship,
    });
    setBusy(false);
    if (!ok) {
      setFailed(true);
      return;
    }
    setOpen(false);
    setInsurerName("");
    setPolicyNumber("");
    setPolicyholderName("");
    setValidFrom("");
    setValidTo("");
    onAdded();
  }

  if (!open) {
    return (
      <div className="mt-3">
        <Button size="sm" variant="secondary" data-testid="add-coverage" onClick={() => setOpen(true)}>
          {t("patients.insurance.add")}
        </Button>
      </div>
    );
  }

  return (
    <div className="mt-3 grid gap-3 rounded-lg border border-border p-3" data-testid="coverage-form">
      {failed && (
        <p role="alert" className="text-xs text-danger">
          {t("patients.insurance.addFailed")}
        </p>
      )}
      {companies.length > 0 && (
        <Select
          label={t("patients.insurance.company")}
          value={companyId}
          placeholder={t("patients.insurance.companyNone")}
          options={companies.map((company) => ({ value: company.id, label: company.name }))}
          onChange={(event) => {
            const id = event.target.value;
            setCompanyId(id);
            // The typed name follows the registry choice, so the policy row and the registry agree
            // rather than carrying two spellings of one insurer.
            const picked = companies.find((company) => company.id === id);
            if (picked !== undefined) setInsurerName(picked.name);
          }}
        />
      )}
      <TextInput
        label={t("patients.insurance.insurer")}
        value={insurerName}
        onChange={(event) => setInsurerName(event.target.value)}
      />
      <TextInput
        label={t("patients.insurance.plan")}
        value={planName}
        onChange={(event) => setPlanName(event.target.value)}
      />
      <label className="flex items-center gap-2 text-sm text-ink">
        <input
          type="checkbox"
          data-testid="coverage-primary"
          checked={isPrimary}
          onChange={(event) => setIsPrimary(event.target.checked)}
        />
        {t("patients.insurance.primary")}
      </label>
      <TextInput
        label={t("patients.insurance.policyNumber")}
        value={policyNumber}
        onChange={(event) => setPolicyNumber(event.target.value)}
      />
      <TextInput
        label={t("patients.insurance.policyholder")}
        value={policyholderName}
        onChange={(event) => setPolicyholderName(event.target.value)}
      />
      <div className="grid gap-3 sm:grid-cols-2">
        <TextInput
          label={t("patients.insurance.validFrom")}
          type="date"
          numeric
          value={validFrom}
          onChange={(event) => setValidFrom(event.target.value)}
        />
        <TextInput
          label={t("patients.insurance.validTo")}
          type="date"
          numeric
          value={validTo}
          onChange={(event) => setValidTo(event.target.value)}
        />
      </div>
      <Select
        label={t("patients.insurance.relationship")}
        value={relationship}
        options={RELATIONSHIPS.map((value) => ({
          value,
          label: t(`intake.rel.${value}` as TranslationKey),
        }))}
        onChange={(event) => setRelationship(event.target.value)}
      />
      <div className="flex gap-2">
        <Button size="sm" disabled={!ready} loading={busy} data-testid="save-coverage" onClick={() => void submit()}>
          {t("settings.save")}
        </Button>
        <Button size="sm" variant="secondary" onClick={() => setOpen(false)}>
          {t("doctors.cancel")}
        </Button>
      </div>
    </div>
  );
}
