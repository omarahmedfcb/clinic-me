import { useRef, useState, type FormEvent } from "react";
import { Button } from "../../design-system/Button.tsx";
import { PasswordField, TextInput, passwordVisibility } from "../../design-system/fields.tsx";
import { useLocale } from "../../i18n/locale-context.tsx";
import { notificationSound } from "../notifications/sound.ts";
import type { TranslationKey } from "../../i18n/strings.ts";
import { LanguageToggle } from "./LanguageToggle.tsx";
import { BuildStamp } from "./BuildStamp.tsx";
import { login } from "./login-api.ts";
import { fetchMe, type CurrentUser } from "./session.tsx";

/**
 * The login screen. One screen: identifier, password, submit, error, loading. Nothing else.
 *
 * ## Phone, not "email or phone"
 *
 * The label says رقم الموبايل and the hint gives an example. Egyptian clinic staff have phones and
 * many have no work email, so offering both would present a choice most users cannot make and would
 * make the field's keyboard ambiguous. The API still accepts an email for the staff who have one —
 * that is a capability, not something to advertise on the front door.
 *
 * ## Arabic-Indic digits, without the user thinking about it
 *
 * A mobile Arabic keyboard produces ٠١٠… by default. The field takes whatever is typed and the
 * server folds both Arabic-Indic ranges to ASCII before parsing (`normalisePhone`). Nothing here
 * rewrites the input as the user types: watching your own digits change under the cursor is
 * alarming, and it would fight an IME mid-composition.
 *
 * `inputMode="numeric"` raises a keypad on mobile. `numeric` on TextInput forces the *value*
 * left-to-right while the label and hint stay right-to-left — a phone number reads LTR even inside
 * Arabic text, and without it the leading `+` lands on the wrong end.
 *
 * ## Direction
 *
 * Nothing here sets a direction. The document carries `dir` (stamped pre-paint from the cached
 * locale, D20) and every rule in this file is a logical property, so flipping the locale to `en`
 * mirrors the layout with no code change. `web-logical-properties.spec.ts` enforces that.
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
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
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

  async function submit(event: FormEvent): Promise<void> {
    /*
      Unlock audio here, inside the submit handler, because this is a real user gesture and it is
      the one guaranteed moment in a receptionist's day: they sign in once, at the start.

      Browsers block audio until the page has been interacted with, and a notification arriving
      before any click plays nothing while `play()` rejects silently — so the first alert of the
      day is the one at risk. Unlocking from a poll would be exactly the case the policy blocks.

      Unconditional, and cheap: creating a suspended AudioContext costs nothing and the sound
      preference is still checked before anything is ever played. Doing it only when sound is
      already on would leave a receptionist who enables it mid-morning unlocked-for-nothing.
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
      const result = await login(identifier, password);
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
    <main className="relative min-h-dvh bg-surface-sunken flex items-center justify-center p-4">
      <LanguageToggle />
      <div className="w-full max-w-sm">
        <header className="mb-6 text-center">
          <h1 className="text-2xl font-semibold text-ink">{t("login.title")}</h1>
          <p className="mt-1 text-sm text-ink-muted">{t("login.subtitle")}</p>
        </header>

        <form
          onSubmit={submit}
          noValidate
          className="rounded-xl border border-border bg-surface p-6 shadow-sm flex flex-col gap-4"
        >
          <TextInput
            label={t("login.phone.label")}
            hint={t("login.phone.hint")}
            error={showFieldErrors && errors.identifier ? t(errors.identifier) : undefined}
            value={identifier}
            onChange={(event) => setIdentifier(event.target.value)}
            // tel, not number: a number input strips the leading zero of 01001234567 and offers
            // spinners on a phone number, which is nonsense.
            type="tel"
            inputMode="numeric"
            autoComplete="username"
            numeric
            required
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
            Deliberately plain text, not a link or a button. There is no self-service reset:
            admin-initiated reset arrives with the users screen in Phase 2, and the OTP path
            designed in SCHEMA-DECISIONS.md D21 waits on WhatsApp in Phase 6. A link to a flow that
            does not exist is worse than a sentence telling you who to ask -- it produces a support
            call about a broken page instead of a conversation with the person who can actually help.
          */}
          <p className="text-center text-xs text-ink-muted">{t("login.forgotPassword")}</p>
          <BuildStamp />
        </form>
      </div>
    </main>
  );
}
