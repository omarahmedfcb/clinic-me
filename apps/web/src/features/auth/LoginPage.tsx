import { useRef, useState, type FormEvent } from "react";
import { BRAND } from "../../brand/brand.ts";
import { BrandLockup } from "../../brand/Logo.tsx";
import { Button } from "../../design-system/Button.tsx";
import { PasswordField, passwordVisibility } from "../../design-system/fields.tsx";
import { useLocale } from "../../i18n/locale-context.tsx";
import { notificationSound } from "../notifications/sound.ts";
import type { TranslationKey } from "../../i18n/strings.ts";
import { LanguageToggle } from "./LanguageToggle.tsx";
import { BuildStamp } from "./BuildStamp.tsx";
import { defaultDiallingCountry, DIALLING_CODES, PhoneField, toE164, type DiallingCountry } from "./PhoneField.tsx";
import { login } from "./login-api.ts";
import { fetchMe, type CurrentUser } from "./session.tsx";

/**
 * The login screen — rebuilt for NOMED OS, item 3 of the 2026-09-15 brief.
 *
 * ## Two columns, one of which disappears
 *
 * The side panel carries the photograph and the logo and is `hidden` under 900px, because a hero
 * image on a phone pushes the form below the fold and a receptionist signing in on a handset wants
 * the field, not the picture. That is a `lg:` breakpoint at Tailwind's default 1024px — deliberately
 * wider than the 900px the brief named, because the panel and a readable form do not both fit at
 * 960px and a squeezed panel is worse than none.
 *
 * ## Phone, not "email or phone"
 *
 * The label says رقم الموبايل and the prefix is a control beside it. Egyptian clinic staff have
 * phones and many have no work email, so offering both would present a choice most users cannot
 * make. The API still accepts an email for the staff who have one — a capability, not something to
 * advertise on the front door.
 *
 * ## Arabic-Indic digits, without the user thinking about it
 *
 * A mobile Arabic keyboard produces ٠١٠… by default. The field takes whatever is typed and the
 * server folds both Arabic-Indic ranges to ASCII before parsing (`normalisePhone`). Nothing here
 * rewrites the input as the user types: watching your own digits change under the cursor is
 * alarming, and it would fight an IME mid-composition.
 *
 * ## Direction
 *
 * Nothing here sets a direction. The document carries `dir` (stamped pre-paint from the cached
 * locale, D20) and every rule in this file is a logical property, so flipping the locale to `en`
 * mirrors the layout with no code change. `web-logical-properties.spec.ts` enforces that.
 *
 * **No OTP and no forgot-password.** Both are Phase 6, and a link to a flow that does not exist
 * produces a support call about a broken page instead of a conversation with the person who can
 * actually help.
 */

/** Client-side checks. Deliberately only emptiness — see the note on `submit`. */
function fieldErrors(identifier: string, password: string): { identifier?: TranslationKey; password?: TranslationKey } {
  return {
    ...(identifier.trim().length === 0 ? { identifier: "login.error.phoneRequired" as const } : {}),
    ...(password.length === 0 ? { password: "login.error.passwordRequired" as const } : {}),
  };
}

export function LoginPage({
  onSignedIn,
  onMustChangePassword,
}: {
  onSignedIn: (token: string, me: CurrentUser) => void;
  /** PR 10: the account holds a temporary password and must replace it before anything else. */
  onMustChangePassword: (token: string) => void;
}) {
  // Reactive, not the module-level `t`: that one is bound to Arabic at import time, so the toggle
  // would flip the direction and leave every string in the language it started in.
  const { t } = useLocale();
  const [country, setCountry] = useState<DiallingCountry>(() => defaultDiallingCountry());
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [rememberMe, setRememberMe] = useState(false);
  /**
   * Whether the password is shown. Held here rather than inside the field so that toggling cannot
   * remount the input and lose what has been typed, and so the two rendered states can be tested.
   *
   * It resets to hidden on every successful sign-in along with the value, for the same reason the
   * value is cleared: a shared reception machine must not leave the next person looking at a
   * password in plain text.
   */
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<TranslationKey | undefined>(undefined);
  const [touched, setTouched] = useState(false);

  /**
   * Guards against a second submit while the first is still in flight.
   *
   * `submitting` already disables the button, but state updates are asynchronous: a double-click on
   * a slow connection, or Enter held down in the password field, can dispatch two submits before
   * React has re-rendered the disabled button. Two login attempts for one intent is not just
   * wasteful — the per-identifier rate limit allows ten per fifteen minutes, so a receptionist on
   * hotel wifi could burn her allowance by being impatient. A ref is checked synchronously and
   * closes that window.
   */
  const inFlight = useRef(false);

  const errors = fieldErrors(identifier, password);
  const showFieldErrors = touched;
  const prefix = DIALLING_CODES.find((row) => row.country === country)?.prefix ?? "+20";

  async function submit(event: FormEvent): Promise<void> {
    /*
      Unlock audio here, inside the submit handler, because this is a real user gesture and it is
      the one guaranteed moment in a receptionist's day: they sign in once, at the start.

      Browsers block audio until the page has been interacted with, and a notification arriving
      before any click plays nothing while `play()` rejects silently — so the first alert of the
      day is the one at risk. Unlocking from a poll would be exactly the case the policy blocks.
    */
    notificationSound.unlock();

    event.preventDefault();
    setTouched(true);

    if (Object.keys(errors).length > 0) return;
    if (inFlight.current) return;

    inFlight.current = true;
    setSubmitting(true);
    setFormError(undefined);

    try {
      // An email still works, and is passed through untouched — `toE164` only applies when what was
      // typed is digits, which is what the field asks for.
      const typed = identifier.trim();
      const sent = /[a-zA-Z@]/.test(typed) ? typed : toE164(prefix, typed);

      const result = await login(sent, password, { rememberMe });
      if (result.ok) {
        // Cleared before anything else: leaving a password in a field after a successful sign-in is
        // a shoulder-surfing problem on a shared reception workstation.
        setPassword("");
        setPasswordVisible(false);

        // A temporary password is outstanding: every other route refuses this session, /auth/me
        // included, so the change screen comes before anything tries to read it.
        if (result.data.mustChangePassword === true) {
          onMustChangePassword(result.data.accessToken);
          return;
        }

        const me = await fetchMe(result.data.accessToken);
        if (me === null) {
          // A token that will not identify itself is not a session. Treat it as a server problem
          // rather than dropping the user into a shell with an empty header.
          setFormError("login.error.server");
          return;
        }
        setFormError(undefined);
        onSignedIn(result.data.accessToken, me);
        return;
      }
      setFormError(result.messageKey);
      // Wrong credentials clears the password and keeps the number: the number is almost never
      // what was wrong, and retyping it is the annoying half.
      if (result.retryable) setPassword("");
    } finally {
      inFlight.current = false;
      setSubmitting(false);
    }
  }

  return (
    <main className="relative flex min-h-dvh bg-surface-sunken">
      <LanguageToggle />

      {/*
        The photograph. `aria-hidden` and empty alt: it is atmosphere, and a screen reader that
        announced it would be reading out a decoration before the form.
      */}
      <aside
        aria-hidden="true"
        data-testid="login-panel"
        className="relative hidden w-1/2 shrink-0 bg-ink lg:block"
      >
        <img
          src={BRAND.loginBackground}
          alt=""
          className="absolute inset-0 h-full w-full object-cover"
          // Below the form in importance: the form is what the page is for.
          fetchPriority="low"
        />
        {/*
          A scrim, not a flat wash.

          The first version was `bg-ink/55` across the whole panel, and the screenshot showed why
          that is not enough: the photograph is a bright glass interior, and 55% navy over its
          palest region still left white type sitting on something close to white. A gradient puts
          the darkness where the type is and leaves the top of the image bright, which is both more
          readable and a better use of the photo.
        */}
        <div className="absolute inset-0 bg-linear-to-t from-ink/90 via-ink/55 to-ink/20" />
        <div className="relative flex h-full flex-col justify-end gap-3 p-10">
          <BrandLockup width={200} className="opacity-95" />
          <p className="max-w-sm text-sm text-white/85">{t("login.panel.tagline")}</p>
        </div>
      </aside>

      <div className="flex flex-1 items-center justify-center p-4">
        <div className="w-full max-w-sm">
          <header className="mb-6">
            {/* On narrow screens the panel is gone, so the logo appears here instead. */}
            <BrandLockup width={132} className="mb-4 lg:hidden" />
            <h1 className="text-2xl font-semibold text-ink">{t("login.title")}</h1>
            <p className="mt-1 text-sm text-ink-muted">{t("login.subtitle")}</p>
          </header>

          <form
            onSubmit={submit}
            noValidate
            className="flex flex-col gap-4 rounded-xl border border-border bg-surface p-6 shadow-sm"
          >
            <PhoneField
              country={country}
              onCountry={setCountry}
              value={identifier}
              onChange={setIdentifier}
              error={showFieldErrors && errors.identifier ? t(errors.identifier) : undefined}
              disabled={submitting}
            />

            <PasswordField
              label={t("login.password.label")}
              error={showFieldErrors && errors.password ? t(errors.password) : undefined}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              visible={passwordVisible}
              onToggleVisible={() => setPasswordVisible((shown) => !shown)}
              toggleLabel={t(passwordVisibility(passwordVisible).labelKey)}
              autoComplete="current-password"
              required
              disabled={submitting}
            />

            {/*
              «تذكرني». Offered to everyone and **granted by the server only to a DOCTOR or a
              RECEPTIONIST** — see `mayRemember` in auth.controller.ts. The box is not hidden by
              role because the screen does not know the role until after the password is right, and
              a checkbox that appeared only after a failed attempt would be stranger than one that
              is quietly not honoured.
            */}
            <label className="flex items-center gap-2 text-sm text-ink-muted">
              <input
                type="checkbox"
                checked={rememberMe}
                onChange={(event) => setRememberMe(event.target.checked)}
                disabled={submitting}
                data-testid="remember-me"
                className="h-4 w-4 rounded border-border-strong text-primary focus-visible:outline-primary"
              />
              {t("login.rememberMe")}
            </label>

            {formError !== undefined && (
              // role="alert" so a screen reader announces it without the user hunting for it, and
              // aria-live so a second failure with the same text is announced again.
              <p role="alert" aria-live="assertive" className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
                {t(formError)}
              </p>
            )}

            <Button type="submit" size="lg" fullWidth loading={submitting}>
              {submitting ? t("login.submitting") : t("login.submit")}
            </Button>

            {/*
              Deliberately plain text, not a link. There is no self-service reset: admin-initiated
              reset is on the users screen, and the OTP path designed in D21 waits on WhatsApp in
              Phase 6. A link to a flow that does not exist is worse than a sentence telling you who
              to ask — it produces a support call about a broken page.
            */}
            <p className="text-center text-xs text-ink-muted">{t("login.noAccount")}</p>

            {/*
              The operator's console — the only thing that says it exists. An operator holds no
              membership, so this page refuses them with the same sentence as a wrong password, and
              that is deliberate: an unauthenticated caller must not learn which accounts exist. A
              link leaks no account and no credential.
            */}
            <p className="text-center text-xs">
              <a
                href="/platform"
                data-testid="platform-console-link"
                className="text-ink-subtle underline decoration-border-strong underline-offset-2 hover:text-primary"
              >
                {t("login.operatorConsole")}
              </a>
            </p>
            <BuildStamp />
          </form>
        </div>
      </div>
    </main>
  );
}
