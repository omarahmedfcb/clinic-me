// The operator's sign-in — password, then the second factor. Separate from the clinic's, because
// they have no membership to pick, and two steps because the password alone opens nothing.

import { useState } from "react";
import { Button } from "../../design-system/Button.tsx";
import { PasswordField, TextInput } from "../../design-system/fields.tsx";
import { useLocale } from "../../i18n/locale-context.tsx";
import { answerSecondFactor, beginEnrolment, platformLogin, signInWithRecoveryCode } from "./platform-api.ts";
import { qrSvg } from "./qr.ts";
import { RecoveryCodesPanel } from "./RecoveryCodesPanel.tsx";
import { refusalText } from "./refusal-text.ts";

type Step =
  | { kind: "password" }
  /** Enrolled already: read the current code. */
  | { kind: "challenge"; fullName: string }
  /** Never enrolled, or an owner cleared it: import the secret first, then read a code. */
  | { kind: "enrol"; fullName: string; secretBase32: string; otpauthUri: string }
  /** The authenticator is gone. One of the eight codes, each good once. */
  | { kind: "recovery"; fullName: string }
  /** The first set, at enrolment. Shown here because there is no route that reads them back. */
  | { kind: "codes"; fullName: string; codes: string[] };

export function OperatorLogin({ onSignedIn }: { onSignedIn: (name: string) => void }) {
  const { t } = useLocale();
  const [step, setStep] = useState<Step>({ kind: "password" });
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [visible, setVisible] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submitPassword(): Promise<void> {
    setBusy(true);
    setFailed(null);
    const result = await platformLogin(identifier, password);
    // Cleared before anything else: a shared laptop must not be left showing it.
    setPassword("");
    setVisible(false);

    if (!result.ok) {
      setBusy(false);
      setFailed(t("login.error.invalid"));
      return;
    }

    // `OPERATOR_TOTP=off`: the server already issued a usable token. Development and review only —
    // the API will not boot with that flag when NODE_ENV=production.
    if (!result.totpRequired) {
      setBusy(false);
      onSignedIn(result.fullName);
      return;
    }

    if (result.totpEnrolled) {
      setBusy(false);
      setStep({ kind: "challenge", fullName: result.fullName });
      return;
    }

    const enrolment = await beginEnrolment();
    setBusy(false);
    if (!enrolment.ok) {
      setFailed(refusalText(t, enrolment.code, enrolment.params));
      return;
    }
    setStep({ kind: "enrol", fullName: result.fullName, ...enrolment });
  }

  async function submitCode(): Promise<void> {
    if (step.kind === "password" || step.kind === "codes") return;
    setBusy(true);
    setFailed(null);

    // One prompt, three meanings, decided by which step we are on.
    const result =
      step.kind === "recovery"
        ? await signInWithRecoveryCode(code)
        : await answerSecondFactor(code, step.kind === "enrol" ? "confirm" : "verify");

    setBusy(false);
    setCode("");
    if (!result.ok) {
      setFailed(refusalText(t, result.code, result.params));
      return;
    }

    // Enrolment hands back the first set, and this screen is the only place they will ever appear.
    if ("recoveryCodes" in result && result.recoveryCodes !== null) {
      setStep({ kind: "codes", fullName: result.fullName, codes: result.recoveryCodes });
      return;
    }
    onSignedIn(result.fullName);
  }

  return (
    <main className="mx-auto max-w-sm p-6" data-testid="platform-login">
      <h1 className="mb-1 text-lg font-semibold text-ink">{t("platform.title")}</h1>
      <p className="mb-4 text-sm text-ink-muted">{t("platform.loginHint")}</p>

      {step.kind === "password" ? (
        <div className="flex flex-col gap-3">
          <TextInput
            label={t("login.phone.label")}
            numeric
            type="tel"
            inputMode="tel"
            value={identifier}
            data-testid="operator-identifier"
            onChange={(event) => setIdentifier(event.target.value)}
          />
          <PasswordField
            label={t("login.password.label")}
            value={password}
            visible={visible}
            toggleLabel={t(visible ? "login.password.hide" : "login.password.show")}
            data-testid="operator-password"
            onToggleVisible={() => setVisible(!visible)}
            onChange={(event) => setPassword(event.target.value)}
          />
          {failed !== null && (
            <p role="alert" className="text-sm text-danger" data-testid="operator-login-failed">
              {failed}
            </p>
          )}
          <Button loading={busy} data-testid="operator-sign-in" onClick={() => void submitPassword()}>
            {t("login.submit")}
          </Button>
        </div>
      ) : step.kind === "codes" ? (
        <RecoveryCodesPanel codes={step.codes} onDone={() => onSignedIn(step.fullName)} />
      ) : (
        <div className="flex flex-col gap-3" data-testid="operator-second-factor">
          {step.kind === "enrol" && (
            <div className="rounded-lg border border-border bg-surface-sunken p-3">
              <p className="text-sm text-ink">{t("platform.totp.enrolHint")}</p>

              {/*
                The QR, and the key underneath it.

                Both, because either one alone fails somebody: a phone camera is the fast path, and
                an operator setting up a desktop authenticator — or holding the phone the console is
                running on — needs something to paste. `qr.ts` encodes it here rather than through a
                dependency; the guard that matters is the Reed-Solomon syndrome check, since a QR
                with wrong error-correction bytes still looks exactly like a right one.
              */}
              <div
                className="mx-auto mt-3 w-44 rounded bg-white p-2"
                data-testid="totp-qr"
                // The SVG is generated from the URI on this machine and contains no markup from it:
                // `qrSvg` emits a fixed shape whose only variable is a path of rectangles.
                dangerouslySetInnerHTML={{ __html: qrSvg(step.otpauthUri, { scale: 4 }) }}
              />

              <p className="mt-3 text-xs text-ink-muted">{t("platform.totp.manualKey")}</p>
              <p
                className="numeric mt-1 select-all break-all rounded bg-surface px-2 py-1 text-sm"
                data-testid="totp-secret"
              >
                {step.secretBase32}
              </p>
            </div>
          )}
          <p className="text-sm text-ink-muted">
            {/* Its own string: `recovery.shownOnce` belongs to the codes panel and says the codes
                will not be shown again, which is the wrong sentence in front of a code entry box. */}
            {step.kind === "recovery" ? t("recovery.enterCode") : t("platform.totp.codeHint")}
          </p>
          <TextInput
            label={step.kind === "recovery" ? t("recovery.codeLabel") : t("platform.totp.code")}
            numeric={step.kind !== "recovery"}
            value={code}
            data-testid={step.kind === "recovery" ? "operator-recovery-code" : "operator-totp"}
            onChange={(event) => setCode(event.target.value)}
          />
          {failed !== null && (
            <p role="alert" className="text-sm text-danger" data-testid="operator-login-failed">
              {failed}
            </p>
          )}
          <Button loading={busy} data-testid="operator-verify" onClick={() => void submitCode()}>
            {t("platform.totp.submit")}
          </Button>

          {/* Offered only to an operator who already has a factor — enrolling one has no codes yet. */}
          {step.kind !== "enrol" && (
            <Button
              size="sm"
              variant="ghost"
              data-testid="operator-use-recovery"
              onClick={() => {
                setCode("");
                setFailed(null);
                setStep(
                  step.kind === "recovery"
                    ? { kind: "challenge", fullName: step.fullName }
                    : { kind: "recovery", fullName: step.fullName },
                );
              }}
            >
              {t(step.kind === "recovery" ? "recovery.backToCode" : "recovery.useCode")}
            </Button>
          )}
        </div>
      )}
    </main>
  );
}
