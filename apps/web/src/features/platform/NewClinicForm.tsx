// Creating a clinic and its first admin — 0b. Split out of `PlatformConsole.tsx` when the back
// office arrived and that file passed the 300-line convention.

import { useState } from "react";
import { Button } from "../../design-system/Button.tsx";
import { Card } from "../../design-system/display.tsx";
import { Select, TextInput } from "../../design-system/fields.tsx";
import { useLocale } from "../../i18n/locale-context.tsx";
import type { TranslationKey } from "../../i18n/strings.ts";
import { cx } from "../../lib/cx.ts";
import type { NewClinicInput } from "./platform-api.ts";
import { rangeIsAcceptable, todayIso } from "./subscription-days.ts";

/** "new": a number nobody has used on WhatsApp. "existing": the clinic's WhatsApp Business app number (coexistence). */
export type NumberType = "new" | "existing";
export type NewClinicSubmit = { whatsapp: false } | { whatsapp: true; existingNumber: boolean };

export const BLANK_CLINIC: NewClinicInput = {
  name: "",
  slug: "",
  timezone: "Africa/Cairo",
  country: "EG",
  currency: "EGP",
  address: "",
  phone: "",
  adminFullName: "",
  adminPhone: "",
  nameEn: "",
  subscriptionStartsOn: "",
  renewalOn: "",
};

/** The server's rule, spelled once here so the screen can say so before the request is sent. */
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * The short name is the field that produced the founder's 2026-09-15 report.
 *
 * The server's refusal now names it, but the better answer is not to send it: a person typing a
 * clinic's name into a field labelled "short name" gets told the rule while they are still in the
 * field, rather than after a round trip. Both halves stay — the client hint is a convenience and
 * the server's rule is the authority.
 */
export const slugProblem = (slug: string): boolean => slug.trim() !== "" && !SLUG.test(slug.trim());

export function NewClinicForm({
  draft,
  busy,
  onChange,
  onSubmit,
  onCancel,
}: {
  draft: NewClinicInput;
  busy: boolean;
  onChange: (next: NewClinicInput) => void;
  onSubmit: (mode: NewClinicSubmit) => void;
  onCancel: () => void;
}) {
  const { t } = useLocale();
  const [numberType, setNumberType] = useState<NumberType | null>(null);
  const set = (key: keyof NewClinicInput) => (value: string) => onChange({ ...draft, [key]: value });
  const badSlug = slugProblem(draft.slug);

  const ready =
    draft.name.trim() !== "" &&
    draft.slug.trim() !== "" &&
    !badSlug &&
    draft.address.trim() !== "" &&
    draft.phone.trim() !== "" &&
    draft.adminFullName.trim() !== "" &&
    draft.adminPhone.trim() !== "" &&
    rangeIsAcceptable(draft.subscriptionStartsOn, draft.renewalOn);

  return (
    <Card title={t("platform.newClinic")} subtitle={t("platform.firstAdminIsUs")}>
      <div className="grid gap-3 sm:grid-cols-2">
        <TextInput label={t("platform.clinicName")} value={draft.name} data-testid="clinic-name" onChange={(e) => set("name")(e.target.value)} />
        <TextInput
          label={t("platform.slug")}
          hint={t("platform.slugHint")}
          error={badSlug ? t("platform.slugInvalid") : undefined}
          value={draft.slug}
          data-testid="clinic-slug"
          onChange={(e) => set("slug")(e.target.value)}
        />
        <TextInput
          label={t("platform.clinicNameEn")}
          hint={t("platform.clinicNameEnHint")}
          dir="ltr"
          value={draft.nameEn ?? ""}
          data-testid="clinic-name-en"
          onChange={(e) => set("nameEn")(e.target.value)}
        />
        <TextInput label={t("platform.address")} value={draft.address} data-testid="clinic-address" onChange={(e) => set("address")(e.target.value)} />
        <TextInput
          label={t("platform.phone")}
          hint={t("platform.phoneHint")}
          numeric
          type="tel"
          inputMode="tel"
          value={draft.phone}
          data-testid="clinic-phone"
          onChange={(e) => set("phone")(e.target.value)}
        />
        <TextInput label={t("platform.timezone")} value={draft.timezone} data-testid="clinic-timezone" onChange={(e) => set("timezone")(e.target.value)} />
        <Select
          label={t("platform.country")}
          value={draft.country}
          data-testid="clinic-country"
          options={["EG", "SA", "AE"].map((value) => ({ value, label: t(`platform.country.${value}` as TranslationKey) }))}
          onChange={(e) => onChange({ ...draft, country: e.target.value as "EG" | "SA" | "AE" })}
        />
        <Select
          label={t("platform.currency")}
          value={draft.currency}
          data-testid="clinic-currency"
          options={["EGP", "SAR", "AED"].map((value) => ({ value, label: value }))}
          onChange={(e) => set("currency")(e.target.value)}
        />
        <TextInput label={t("platform.adminName")} value={draft.adminFullName} data-testid="admin-name" onChange={(e) => set("adminFullName")(e.target.value)} />
        <TextInput
          label={t("platform.adminPhone")}
          hint={t("platform.phoneHint")}
          numeric
          type="tel"
          inputMode="tel"
          value={draft.adminPhone}
          data-testid="admin-phone"
          onChange={(e) => set("adminPhone")(e.target.value)}
        />
        <TextInput
          label={t("platform.subscriptionStartsOn")}
          hint={t("platform.subscriptionStartsOnHint")}
          type="date"
          dir="ltr"
          min={todayIso()}
          value={draft.subscriptionStartsOn}
          data-testid="clinic-subscription-starts-on"
          onChange={(e) => set("subscriptionStartsOn")(e.target.value)}
        />
        <TextInput
          label={t("platform.subscriptionEndsOn")}
          hint={t("platform.subscriptionEndsOnHint")}
          type="date"
          dir="ltr"
          min={draft.subscriptionStartsOn !== "" ? draft.subscriptionStartsOn : todayIso()}
          value={draft.renewalOn}
          data-testid="clinic-renewal-on"
          onChange={(e) => set("renewalOn")(e.target.value)}
        />
      </div>

      <fieldset className="mt-4 flex flex-col gap-2 border-t border-border pt-4" disabled={busy}>
        <legend className="mb-2 text-sm font-semibold text-ink">{t("signup.numberType.title")}</legend>
        {(["new", "existing"] as const).map((value) => (
          <label
            key={value}
            className={cx(
              "flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-2.5",
              numberType === value ? "border-primary bg-primary-soft/40" : "border-border",
            )}
          >
            <input
              type="radio"
              name="number-type"
              value={value}
              checked={numberType === value}
              data-testid={`number-type-${value}`}
              onChange={() => setNumberType(value)}
              className="mt-1"
            />
            <span>
              <span className="block text-sm font-medium text-ink">{t(`signup.numberType.${value}.title` as TranslationKey)}</span>
              <span className="block text-xs text-ink-muted">{t(`signup.numberType.${value}.body` as TranslationKey)}</span>
            </span>
          </label>
        ))}
        {numberType === "existing" && (
          <p role="note" className="rounded-lg bg-warning-soft px-3 py-2 text-xs text-warning">
            {t("signup.numberType.existing.note")}
          </p>
        )}
        <p className="rounded-lg bg-surface-sunken px-3 py-2 text-xs text-ink-muted">{t("signup.whatsapp.note")}</p>
      </fieldset>

      <div className="mt-3 flex flex-wrap gap-2">
        <Button
          loading={busy}
          disabled={!ready || numberType === null}
          data-testid="create-clinic-whatsapp"
          onClick={() => onSubmit({ whatsapp: true, existingNumber: numberType === "existing" })}
        >
          {t("signup.submit")}
        </Button>
        <Button
          variant="secondary"
          loading={busy}
          disabled={!ready}
          data-testid="create-clinic"
          onClick={() => onSubmit({ whatsapp: false })}
        >
          {t("platform.createWithoutWhatsApp")}
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          {t("common.cancel")}
        </Button>
      </div>
    </Card>
  );
}
