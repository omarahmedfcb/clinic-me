// The clinic's letterhead — Q28's fields, Q36's screen. Admin and owner only.
// Until this existed the fields were reachable only with a token and curl, so every sheet printed bare.

import { useCallback, useEffect, useState } from "react";
import { Button } from "../../design-system/Button.tsx";
import { Card } from "../../design-system/display.tsx";
import { InsuranceCompaniesCard } from "./InsuranceCompaniesCard.tsx";
import { TextInput, Textarea } from "../../design-system/fields.tsx";
import { useLocale } from "../../i18n/locale-context.tsx";
import type { TranslationKey } from "../../i18n/strings.ts";
import { ImageField } from "./ImageField.tsx";
import {
  loadClinicIdentity,
  loadLogo,
  removeLogo,
  saveClinicIdentity,
  uploadLogo,
  type ClinicIdentity,
} from "./settings-api.ts";

type AuthFetch = (path: string, init?: RequestInit) => Promise<Response>;

/** Q37's fields, in the order they appear on the sheet. Driven from one list so none is forgotten. */
const EXTRA_FIELDS = [
  // Q45: printed documents are English whatever the interface language is, so these two are what
  // the letterhead actually uses. First in the list because they are the first thing on the sheet.
  "nameEn",
  "addressEn",
  "tagline",
  "email",
  "whatsappPhone",
  "printedWorkingHours",
  "taxRegistrationNumber",
  "commercialRegisterNumber",
] as const;

type ExtraField = (typeof EXTRA_FIELDS)[number];

const EMPTY_EXTRA = Object.fromEntries(EXTRA_FIELDS.map((f) => [f, ""])) as Record<ExtraField, string>;

export function ClinicSettingsPage({ authFetch }: { authFetch: AuthFetch }) {
  const { t } = useLocale();
  const [identity, setIdentity] = useState<ClinicIdentity | null>(null);
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [phone, setPhone] = useState("");
  const [secondaryPhone, setSecondaryPhone] = useState("");
  // Q37. Held as one record rather than six pieces of state: they are all optional free text and
  // they are all saved together, so six setters would be five chances to forget one.
  const [extra, setExtra] = useState<Record<ExtraField, string>>(EMPTY_EXTRA);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const refresh = useCallback(async () => {
    const value = await loadClinicIdentity(authFetch);
    if (value === null) return;
    setIdentity(value);
    setName(value.name);
    setAddress(value.address);
    setPhone(value.phone);
    setSecondaryPhone(value.secondaryPhone ?? "");
    setExtra(Object.fromEntries(EXTRA_FIELDS.map((f) => [f, value[f] ?? ""])) as Record<ExtraField, string>);
  }, [authFetch]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function save(): Promise<void> {
    setSaving(true);
    const value = await saveClinicIdentity(authFetch, {
      name,
      address,
      phone,
      // Empty clears it, and `null` is what the API reads as "clear" rather than as "leave alone".
      secondaryPhone: secondaryPhone.trim() === "" ? null : secondaryPhone,
      ...Object.fromEntries(
        EXTRA_FIELDS.map((f) => [f, extra[f].trim() === "" ? null : extra[f]]),
      ),
    });
    setSaving(false);
    if (value === null) return;
    setIdentity(value);
    setPhone(value.phone);
    setSecondaryPhone(value.secondaryPhone ?? "");
    setExtra(Object.fromEntries(EXTRA_FIELDS.map((f) => [f, value[f] ?? ""])) as Record<ExtraField, string>);
    setSaved(true);
  }

  return (
    <main className="mx-auto max-w-2xl p-6" data-testid="clinic-settings">
      <h1 className="mb-4 text-lg font-semibold text-ink">{t("settings.clinic.title")}</h1>

      <Card title={t("settings.clinic.letterhead")}>
        <div className="grid gap-4">
          <TextInput
            label={t("settings.clinic.name")}
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              setSaved(false);
            }}
          />
          <Textarea
            label={t("settings.clinic.address")}
            rows={2}
            value={address}
            onChange={(event) => {
              setAddress(event.target.value);
              setSaved(false);
            }}
          />
          <TextInput
            label={t("settings.clinic.phone")}
            numeric
            type="tel"
            inputMode="tel"
            value={phone}
            onChange={(event) => {
              setPhone(event.target.value);
              setSaved(false);
            }}
          />
          {/* A five-digit hotline is kept as typed; a landline is parsed to E.164. The server
              decides, and the value it returns is what lands back in this box. */}
          <TextInput
            label={t("settings.clinic.secondaryPhone")}
            numeric
            type="tel"
            inputMode="tel"
            hint={t("settings.clinic.phoneHint")}
            value={secondaryPhone}
            onChange={(event) => {
              setSecondaryPhone(event.target.value);
              setSaved(false);
            }}
          />

          {EXTRA_FIELDS.map((field) => (
            <TextInput
              key={field}
              label={t(`settings.clinic.${field}` as TranslationKey)}
              numeric={field === "whatsappPhone" || field.endsWith("Number")}
              value={extra[field]}
              onChange={(event) => {
                setExtra((previous) => ({ ...previous, [field]: event.target.value }));
                setSaved(false);
              }}
            />
          ))}

          <div className="flex items-center gap-3">
            <Button data-testid="save-clinic" loading={saving} onClick={() => void save()}>
              {t("settings.save")}
            </Button>
            {saved && <span className="text-xs text-success">{t("settings.saved")}</span>}
          </div>
        </div>
      </Card>

      <div className="mt-4">
        <Card title={t("settings.clinic.logo")}>
          <ImageField
            label={t("settings.clinic.logo")}
            testId="clinic-logo"
            present={identity?.hasLogo === true}
            load={() => loadLogo(authFetch)}
            upload={(file) => uploadLogo(authFetch, file)}
            remove={() => removeLogo(authFetch)}
            onChanged={() => void refresh()}
          />
          {/* Said plainly, because "remove" usually means destroyed and here it does not. */}
          <p className="mt-2 text-xs text-ink-subtle">{t("settings.removeKeepsFile")}</p>
        </Card>
      </div>

      {/* Phase 5 PR 1: the registry is clinic configuration, so it lives with the other settings. */}
      <div className="mt-4">
        <InsuranceCompaniesCard authFetch={authFetch} />
      </div>
    </main>
  );
}
