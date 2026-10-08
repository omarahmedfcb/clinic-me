import { useEffect, useRef, useState, type FormEvent } from "react";
import { BRAND } from "../../brand/brand.ts";
import { BrandLockup } from "../../brand/Logo.tsx";
import { Button } from "../../design-system/Button.tsx";
import { PasswordField, passwordVisibility, Select, TextInput } from "../../design-system/fields.tsx";
import { Spinner } from "../../design-system/Spinner.tsx";
import { useLocale } from "../../i18n/locale-context.tsx";
import type { TranslationKey } from "../../i18n/strings.ts";
import { LanguageToggle } from "../auth/LanguageToggle.tsx";
import { defaultDiallingCountry, DIALLING_CODES, toE164, type DiallingCountry } from "../auth/PhoneField.tsx";
import { fetchSignupConfig, submitSignup, type SignupConfig } from "./signup-api.ts";
import { launchEmbeddedSignup, loadFacebookSdk } from "./meta-signup.ts";

/**
 * Public clinic signup. Built to sit beside LoginPage: the same two-column layout, the same card,
 * the same language toggle, and every string from the catalogue so the toggle works here too.
 *
 * Phones are sent as E.164 (prefix from the country select plus the typed digits), the same way
 * login does it, so the server never has to guess the country from its own default.
 */

const MIN_PASSWORD = 12;

interface FormState {
  clinicName: string;
  clinicNameEn: string;
  address: string;
  clinicPhone: string;
  ownerFullName: string;
  ownerPhone: string;
  password: string;
}

const EMPTY: FormState = {
  clinicName: "",
  clinicNameEn: "",
  address: "",
  clinicPhone: "",
  ownerFullName: "",
  ownerPhone: "",
  password: "",
};

function fieldErrors(form: FormState): Partial<Record<keyof FormState, TranslationKey>> {
  const empty = (value: string): boolean => value.trim().length === 0;
  return {
    ...(empty(form.clinicName) ? { clinicName: "signup.error.required" as const } : {}),
    ...(empty(form.address) ? { address: "signup.error.required" as const } : {}),
    ...(empty(form.clinicPhone) ? { clinicPhone: "signup.error.required" as const } : {}),
    ...(empty(form.ownerFullName) ? { ownerFullName: "signup.error.required" as const } : {}),
    ...(empty(form.ownerPhone) ? { ownerPhone: "signup.error.required" as const } : {}),
    ...(form.password.length < MIN_PASSWORD ? { password: "signup.error.password" as const } : {}),
  };
}

export function SignupPage() {
  const { t } = useLocale();
  const [config, setConfig] = useState<SignupConfig | null | undefined>(undefined);
  const [country, setCountry] = useState<DiallingCountry>(() => defaultDiallingCountry());
  const [form, setForm] = useState<FormState>(EMPTY);
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [touched, setTouched] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<TranslationKey | undefined>(undefined);
  const [done, setDone] = useState<{ displayPhoneNumber: string | null } | undefined>(undefined);
  const inFlight = useRef(false);

  useEffect(() => {
    void fetchSignupConfig().then(setConfig, () => setConfig(null));
  }, []);

  const errors = fieldErrors(form);
  const prefix = DIALLING_CODES.find((row) => row.country === country)?.prefix ?? "+20";
  const shown = (key: keyof FormState): string | undefined =>
    touched && errors[key] !== undefined ? t(errors[key]) : undefined;
  const set = (key: keyof FormState) => (event: { target: { value: string } }) =>
    setForm((previous) => ({ ...previous, [key]: event.target.value }));

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setTouched(true);
    if (config === null || config === undefined) return;
    if (Object.keys(errors).length > 0 || inFlight.current) return;

    inFlight.current = true;
    setSubmitting(true);
    setFormError(undefined);
    try {
      const fb = await loadFacebookSdk(config.appId, config.graphVersion);
      const outcome = await launchEmbeddedSignup(fb, config.configId);
      if (outcome.kind === "cancelled") return setFormError("signup.error.cancelled");
      if (outcome.kind === "error") return setFormError("signup.error.UNKNOWN");

      const result = await submitSignup({
        clinicName: form.clinicName.trim(),
        clinicNameEn: form.clinicNameEn.trim() || undefined,
        address: form.address.trim(),
        clinicPhone: toE164(prefix, form.clinicPhone),
        ownerFullName: form.ownerFullName.trim(),
        ownerPhone: toE164(prefix, form.ownerPhone),
        password: form.password,
        ...outcome.result,
      });
      if (result.ok) {
        setForm((previous) => ({ ...previous, password: "" }));
        setPasswordVisible(false);
        setDone({ displayPhoneNumber: result.displayPhoneNumber });
      } else {
        setFormError(`signup.error.${result.failure}` as TranslationKey);
      }
    } catch {
      setFormError("signup.error.UNKNOWN");
    } finally {
      inFlight.current = false;
      setSubmitting(false);
    }
  }

  const panel = (
    <aside aria-hidden="true" data-testid="signup-panel" className="relative hidden w-1/2 shrink-0 bg-ink lg:block">
      <img src={BRAND.loginBackground} alt="" className="absolute inset-0 h-full w-full object-cover" fetchPriority="low" />
      <div className="absolute inset-0 bg-linear-to-t from-ink/90 via-ink/55 to-ink/20" />
      <div className="relative flex h-full flex-col justify-end gap-3 p-10">
        <BrandLockup width={200} className="opacity-95" />
        <p className="max-w-sm text-sm text-white/85">{t("signup.panel.tagline")}</p>
      </div>
    </aside>
  );

  if (config === undefined) {
    return (
      <main className="relative flex min-h-dvh items-center justify-center bg-surface-sunken">
        <LanguageToggle />
        <Spinner size="lg" />
      </main>
    );
  }

  if (done !== undefined) {
    return (
      <main className="relative flex min-h-dvh bg-surface-sunken">
        <LanguageToggle />
        {panel}
        <div className="flex flex-1 items-center justify-center p-4">
          <div className="w-full max-w-sm">
            <BrandLockup width={132} className="mb-4 lg:hidden" />
            <div className="flex flex-col gap-4 rounded-xl border border-border bg-surface p-6 shadow-sm">
              <h1 className="text-2xl font-semibold text-ink">{t("signup.success.title")}</h1>
              <p className="text-sm text-ink-muted">{t("signup.success.body")}</p>
              {done.displayPhoneNumber !== null && (
                <div className="rounded-lg bg-surface-sunken px-3 py-2">
                  <p className="text-xs text-ink-muted">{t("signup.success.number")}</p>
                  <p dir="ltr" className="text-start text-sm font-medium text-ink">{done.displayPhoneNumber}</p>
                </div>
              )}
              <a href="/" className="block">
                <Button type="button" size="lg" fullWidth>{t("signup.success.signIn")}</Button>
              </a>
            </div>
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="relative flex min-h-dvh bg-surface-sunken">
      <LanguageToggle />
      {panel}

      <div className="flex flex-1 items-center justify-center p-4 py-16">
        <div className="w-full max-w-md">
          <header className="mb-6">
            <BrandLockup width={132} className="mb-4 lg:hidden" />
            <h1 className="text-2xl font-semibold text-ink">{t("signup.title")}</h1>
            <p className="mt-1 text-sm text-ink-muted">{t("signup.subtitle")}</p>
          </header>

          <form
            onSubmit={submit}
            noValidate
            className="flex flex-col gap-4 rounded-xl border border-border bg-surface p-6 shadow-sm"
          >
            <h2 className="text-sm font-semibold text-ink">{t("signup.section.clinic")}</h2>
            <TextInput label={t("signup.clinic.name.label")} value={form.clinicName} onChange={set("clinicName")} error={shown("clinicName")} required disabled={submitting} />
            <TextInput label={t("signup.clinic.nameEn.label")} hint={t("signup.clinic.nameEn.hint")} value={form.clinicNameEn} onChange={set("clinicNameEn")} dir="ltr" disabled={submitting} />
            <TextInput label={t("signup.clinic.address.label")} value={form.address} onChange={set("address")} error={shown("address")} required disabled={submitting} />

            <div className="flex items-start gap-2">
              <div className="w-28 shrink-0">
                <Select
                  label={t("signup.phone.country")}
                  value={country}
                  options={DIALLING_CODES.map((row) => ({ value: row.country, label: row.prefix }))}
                  onChange={(event) => setCountry(event.target.value as DiallingCountry)}
                  disabled={submitting}
                />
              </div>
              <div className="flex-1">
                <TextInput label={t("signup.clinic.phone.label")} hint={t("signup.clinic.phone.hint")} value={form.clinicPhone} onChange={set("clinicPhone")} error={shown("clinicPhone")} type="tel" inputMode="tel" numeric required disabled={submitting} />
              </div>
            </div>

            <h2 className="mt-2 border-t border-border pt-4 text-sm font-semibold text-ink">{t("signup.section.owner")}</h2>
            <TextInput label={t("signup.owner.name.label")} value={form.ownerFullName} onChange={set("ownerFullName")} error={shown("ownerFullName")} autoComplete="name" required disabled={submitting} />
            <TextInput label={t("signup.owner.phone.label")} hint={t("signup.owner.phone.hint")} value={form.ownerPhone} onChange={set("ownerPhone")} error={shown("ownerPhone")} type="tel" inputMode="tel" autoComplete="username" numeric required disabled={submitting} />
            <PasswordField
              label={t("signup.password.label")}
              hint={t("signup.password.hint")}
              error={shown("password")}
              value={form.password}
              onChange={set("password")}
              visible={passwordVisible}
              onToggleVisible={() => setPasswordVisible((value) => !value)}
              toggleLabel={t(passwordVisibility(passwordVisible).labelKey)}
              autoComplete="new-password"
              required
              disabled={submitting}
            />

            <p className="rounded-lg bg-surface-sunken px-3 py-2 text-xs text-ink-muted">{t("signup.whatsapp.note")}</p>

            {config === null && (
              <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">{t("signup.error.notConfigured")}</p>
            )}
            {formError !== undefined && (
              <p role="alert" aria-live="assertive" className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">{t(formError)}</p>
            )}

            <Button type="submit" size="lg" fullWidth loading={submitting} disabled={config === null}>
              {submitting ? t("signup.submitting") : t("signup.submit")}
            </Button>

            <p className="text-center text-xs text-ink-muted">
              {t("signup.haveAccount")}{" "}
              <a href="/" data-testid="signup-login-link" className="font-medium text-primary underline underline-offset-2">
                {t("signup.signIn")}
              </a>
            </p>
          </form>
        </div>
      </div>
    </main>
  );
}
