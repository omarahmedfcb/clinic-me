// The phone field with a country prefix control. Item 3 of the 2026-09-15 rebrand.

import { Select, TextInput } from "../../design-system/fields.tsx";
import { useLocale } from "../../i18n/locale-context.tsx";
import type { TranslationKey } from "../../i18n/strings.ts";

/**
 * The countries the login offers a prefix for.
 *
 * Three, because `tenants.country` already has a CHECK admitting exactly these and a login screen
 * offering a fourth would be promising a clinic the rest of the system cannot create. The brief's
 * "more countries later" is a migration to that CHECK plus a line here, in that order.
 */
export const DIALLING_CODES = [
  { country: "EG", prefix: "+20", label: "platform.country.EG" },
  { country: "SA", prefix: "+966", label: "platform.country.SA" },
  { country: "AE", prefix: "+971", label: "platform.country.AE" },
] as const;

export type DiallingCountry = (typeof DIALLING_CODES)[number]["country"];

/**
 * The default, from the browser's own locale.
 *
 * `navigator.language` is a hint about the person, not about the clinic — `ar-EG` means an Egyptian
 * keyboard, and every seeded and pilot clinic is Egyptian — so EG is both the derived answer and
 * the fallback. Read once at call time rather than at module scope, because a unit spec that
 * imports this file must not need a `navigator`.
 */
export function defaultDiallingCountry(locales: readonly string[] = navigator.languages ?? []): DiallingCountry {
  for (const tag of locales) {
    const region = tag.split("-")[1]?.toUpperCase();
    const match = DIALLING_CODES.find((entry) => entry.country === region);
    if (match !== undefined) return match.country;
  }
  return "EG";
}

/** The E.164 the server is sent: the prefix, then the digits with any leading zero dropped. */
export function toE164(prefix: string, typed: string): string {
  const digits = typed.replace(/\D/g, "").replace(/^0+/, "");
  return digits === "" ? "" : `${prefix}${digits}`;
}

export function PhoneField({
  country,
  onCountry,
  value,
  onChange,
  error,
  disabled,
}: {
  country: DiallingCountry;
  onCountry: (next: DiallingCountry) => void;
  value: string;
  onChange: (next: string) => void;
  error?: string | undefined;
  disabled?: boolean;
}) {
  const { t } = useLocale();
  const entry = DIALLING_CODES.find((row) => row.country === country) ?? DIALLING_CODES[0];

  return (
    <div className="flex items-end gap-2">
      {/*
        The prefix is a control, not decoration: a clinic in Riyadh types the same nine digits an
        Egyptian one does, and asking them to remember `+966` is asking them to do the computer's
        job. `numeric` on the number keeps it left-to-right inside the Arabic form.
      */}
      <div className="w-28 shrink-0">
        <Select
          label={t("login.phone.country")}
          value={country}
          data-testid="login-country"
          options={DIALLING_CODES.map((row) => ({ value: row.country, label: `${row.prefix}` }))}
          onChange={(event) => onCountry(event.target.value as DiallingCountry)}
          disabled={disabled}
        />
      </div>
      <div className="flex-1">
        <TextInput
          label={t("login.phone.label")}
          hint={t(`login.phone.hint.${entry.country}` as TranslationKey)}
          error={error}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          // tel, not number: a number input strips the leading zero of 01001234567 and offers
          // spinners on a phone number, which is nonsense.
          type="tel"
          // tel, not numeric: a digits-only keypad has no `+`, so a Gulf number or one pasted from
          // WhatsApp cannot be typed on a phone. Normalising is the server's job.
          inputMode="tel"
          autoComplete="username"
          numeric
          required
          disabled={disabled}
          data-testid="login-phone"
        />
      </div>
    </div>
  );
}
