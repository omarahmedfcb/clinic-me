// The client file for one clinic — 2b and 2c. The vendor's own record of a customer: contacts, who
// owns the account, what was agreed, the contracts, and when it renews.

import { useCallback, useEffect, useState } from "react";
import { Button } from "../../design-system/Button.tsx";
import { Card } from "../../design-system/display.tsx";
import { Select, TextInput } from "../../design-system/fields.tsx";
import { MoneyInput } from "../../design-system/MoneyInput.tsx";
import { useLocale } from "../../i18n/locale-context.tsx";
import type { TranslationKey } from "../../i18n/strings.ts";
import {
  addContact,
  addContract,
  downloadContract,
  loadClientFile,
  removeContact,
  saveClientFile,
  type Clinic,
  type ClientFile,
  type Operator,
} from "./platform-api.ts";
import { refusalText } from "./refusal-text.ts";

const ACCOUNT_STATUSES = ["TRIAL", "ACTIVE", "OVERDUE", "SUSPENDED"] as const;

/** A whole number typed into a field — a percentage, never money. Money goes through MoneyInput. */
const wholeNumber = (typed: string): number | null => {
  const digits = typed.replace(/[^\d]/g, "");
  return digits === "" ? null : Number.parseInt(digits, 10);
};

export function ClientFilePanel({
  clinic,
  operators,
  onClose,
}: {
  clinic: Clinic;
  operators: Operator[];
  onClose: () => void;
}) {
  const { t } = useLocale();
  const [file, setFile] = useState<ClientFile | null>(null);
  /** The agreed price while it is being typed. Re-synced whenever the file is re-read. */
  const [agreedDraft, setAgreedDraft] = useState<number | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [contactName, setContactName] = useState("");
  const [contactRole, setContactRole] = useState("");
  const [contactPhone, setContactPhone] = useState("");
  const [contactEmail, setContactEmail] = useState("");

  const [contractFile, setContractFile] = useState<File | null>(null);
  const [startsOn, setStartsOn] = useState("");
  const [endsOn, setEndsOn] = useState("");

  const refresh = useCallback(async () => {
    const next = await loadClientFile(clinic.tenantId);
    setFile(next);
    setAgreedDraft(next.agreedMonthlyMinor);
  }, [clinic.tenantId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (file === null) {
    return (
      <Card title={t("platform.clientFile")}>
        <p className="text-sm text-ink-muted">{t("common.loading")}</p>
      </Card>
    );
  }

  const act = async (run: () => Promise<{ ok: true } | { ok: false; code: string; params: Record<string, unknown> }>) => {
    setBusy(true);
    setRefusal(null);
    const result = await run();
    if (!result.ok) {
      setBusy(false);
      setRefusal(refusalText(t, result.code, result.params));
      return false;
    }
    await refresh();
    setBusy(false);
    return true;
  };

  // Each field saves on blur, sending only itself. The server leaves an absent field alone, so two
  // operators editing different halves cannot blank each other's work.
  const save = (edit: Parameters<typeof saveClientFile>[1]) => void act(() => saveClientFile(clinic.tenantId, edit));

  return (
    <Card title={`${t("platform.clientFile")} — ${clinic.name}`} subtitle={t("platform.clientFileHint")}>
      {refusal !== null && (
        <p role="alert" className="mb-3 text-sm text-danger" data-testid="client-file-refusal">
          {refusal}
        </p>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <Select
          label={t("platform.accountStatus")}
          value={file.accountStatus}
          data-testid="account-status"
          options={ACCOUNT_STATUSES.map((value) => ({
            value,
            label: t(`platform.account.${value}` as TranslationKey),
          }))}
          onChange={(event) => save({ accountStatus: event.target.value })}
        />
        <Select
          label={t("platform.salesOwner")}
          value={file.salesOwnerUserId ?? ""}
          data-testid="sales-owner"
          options={[
            { value: "", label: t("platform.noSalesOwner") },
            ...operators.map((operator) => ({ value: operator.userId, label: operator.fullName })),
          ]}
          onChange={(event) => save({ salesOwnerUserId: event.target.value === "" ? null : event.target.value })}
        />
        <TextInput
          label={t("platform.agreedPlan")}
          defaultValue={file.agreedPlan ?? ""}
          data-testid="agreed-plan"
          onBlur={(event) => save({ agreedPlan: event.target.value === "" ? null : event.target.value })}
        />
        {/*
          The shared money box, not a plain field: an operator types 2,400.00 and the wire carries
          240000. A box that sent what was typed straight through would have meant the agreed price
          was recorded in piastres — the exact defect `money-inputs-are-shared.spec.ts` was written
          for, and the one it caught here.
        */}
        {/* The wrapper carries the blur: `MoneyInput` has no `onBlur` of its own, and saving on
            every keystroke would be one request per digit. */}
        <div onBlur={() => save({ agreedMonthlyMinor: agreedDraft })}>
          <MoneyInput
            label={t("platform.agreedMonthly")}
            hint={t("platform.agreedMonthlyHint")}
            valueMinor={agreedDraft}
            currency={clinic.currency}
            data-testid="agreed-monthly"
            onChangeMinor={setAgreedDraft}
          />
        </div>
        <TextInput
          label={t("platform.discountPercent")}
          numeric
          defaultValue={file.discountPercent === null ? "" : String(file.discountPercent)}
          data-testid="discount-percent"
          onBlur={(event) => save({ discountPercent: wholeNumber(event.target.value) })}
        />
        <TextInput
          label={t("platform.renewalOn")}
          type="date"
          defaultValue={file.renewalOn ?? ""}
          data-testid="renewal-on"
          onBlur={(event) => save({ renewalOn: event.target.value === "" ? null : event.target.value })}
        />
        {file.accountStatus === "TRIAL" && (
          <TextInput
            label={t("platform.trialEndsOn")}
            type="date"
            defaultValue={file.trialEndsOn ?? ""}
            data-testid="trial-ends-on"
            onBlur={(event) => save({ trialEndsOn: event.target.value === "" ? null : event.target.value })}
          />
        )}
      </div>

      <div className="mt-3">
        <label className="block text-sm text-ink-muted" htmlFor="client-notes">
          {t("platform.notes")}
        </label>
        <textarea
          id="client-notes"
          rows={3}
          defaultValue={file.notes ?? ""}
          data-testid="client-notes"
          className="mt-1 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-ink"
          onBlur={(event) => save({ notes: event.target.value === "" ? null : event.target.value })}
        />
      </div>

      {/* ---- contacts ---- */}
      <h3 className="mt-5 text-sm font-semibold text-ink">{t("platform.contacts")}</h3>
      {file.contacts.length === 0 ? (
        <p className="text-sm text-ink-subtle">{t("platform.noContacts")}</p>
      ) : (
        <ul className="mt-1 flex flex-col gap-1" data-testid="contact-list">
          {file.contacts.map((contact) => (
            <li key={contact.id} className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
              <span>
                <span className="text-ink">{contact.fullName}</span>
                {contact.role !== null && <span className="text-ink-subtle"> · {contact.role}</span>}
                {contact.phoneE164 !== null && <span className="numeric text-ink-subtle"> · {contact.phoneE164}</span>}
                {contact.email !== null && <span className="text-ink-subtle"> · {contact.email}</span>}
              </span>
              <Button
                size="sm"
                variant="ghost"
                loading={busy}
                data-testid={`remove-contact-${contact.id}`}
                onClick={() => void act(() => removeContact(clinic.tenantId, contact.id))}
              >
                {t("common.remove")}
              </Button>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-2 grid gap-2 sm:grid-cols-4">
        <TextInput label={t("platform.contactName")} value={contactName} data-testid="contact-name" onChange={(e) => setContactName(e.target.value)} />
        <TextInput label={t("platform.contactRole")} value={contactRole} data-testid="contact-role" onChange={(e) => setContactRole(e.target.value)} />
        <TextInput label={t("platform.contactPhone")} numeric type="tel" inputMode="tel" value={contactPhone} data-testid="contact-phone" onChange={(e) => setContactPhone(e.target.value)} />
        <TextInput label={t("platform.contactEmail")} value={contactEmail} data-testid="contact-email" onChange={(e) => setContactEmail(e.target.value)} />
      </div>
      <div className="mt-2">
        <Button
          size="sm"
          loading={busy}
          disabled={contactName.trim() === ""}
          data-testid="add-contact"
          onClick={() =>
            void act(async () => {
              const result = await addContact(clinic.tenantId, {
                contactName,
                ...(contactRole === "" ? {} : { contactRole }),
                ...(contactPhone === "" ? {} : { contactPhone }),
                ...(contactEmail === "" ? {} : { contactEmail }),
              });
              if (result.ok) {
                setContactName("");
                setContactRole("");
                setContactPhone("");
                setContactEmail("");
              }
              return result;
            })
          }
        >
          {t("platform.addContact")}
        </Button>
      </div>

      {/* ---- contracts ---- */}
      <h3 className="mt-5 text-sm font-semibold text-ink">{t("platform.contracts")}</h3>
      {file.contracts.length === 0 ? (
        <p className="text-sm text-ink-subtle">{t("platform.noContracts")}</p>
      ) : (
        <ul className="mt-1 flex flex-col gap-1" data-testid="contract-list">
          {file.contracts.map((contract) => (
            <li key={contract.id} className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
              <span>
                <span className="text-ink">{contract.fileName}</span>
                <span className="numeric text-ink-subtle">
                  {" · "}
                  {contract.startsOn} → {contract.endsOn}
                </span>
              </span>
              <Button
                size="sm"
                variant="ghost"
                data-testid={`download-contract-${contract.id}`}
                onClick={() => void downloadContract(clinic.tenantId, contract.id, contract.fileName)}
              >
                {t("platform.download")}
              </Button>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-2 grid gap-2 sm:grid-cols-3">
        <div>
          <label className="block text-sm text-ink-muted" htmlFor="contract-file">
            {t("platform.contractFile")}
          </label>
          <input
            id="contract-file"
            type="file"
            accept="application/pdf"
            data-testid="contract-file"
            className="mt-1 w-full text-sm text-ink"
            onChange={(event) => setContractFile(event.target.files?.[0] ?? null)}
          />
        </div>
        <TextInput label={t("platform.startsOn")} type="date" value={startsOn} data-testid="contract-starts" onChange={(e) => setStartsOn(e.target.value)} />
        <TextInput label={t("platform.endsOn")} type="date" value={endsOn} data-testid="contract-ends" onChange={(e) => setEndsOn(e.target.value)} />
      </div>
      <div className="mt-2 flex gap-2">
        <Button
          size="sm"
          loading={busy}
          disabled={contractFile === null || startsOn === "" || endsOn === ""}
          data-testid="add-contract"
          onClick={() =>
            void act(async () => {
              if (contractFile === null) return { ok: true as const };
              const result = await addContract(clinic.tenantId, { file: contractFile, startsOn, endsOn });
              if (result.ok) {
                setContractFile(null);
                setStartsOn("");
                setEndsOn("");
              }
              return result;
            })
          }
        >
          {t("platform.addContract")}
        </Button>
        <Button size="sm" variant="ghost" data-testid="close-client-file" onClick={onClose}>
          {t("common.close")}
        </Button>
      </div>
    </Card>
  );
}
