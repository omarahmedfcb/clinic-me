// What the console opens on after a recovery login. Postponeable until the next sign-in, never
// dismissable: a recovery code that never leads to a new authenticator is a login, not a recovery.

import { useState } from "react";
import { Button } from "../../design-system/Button.tsx";
import { PasswordField, TextInput } from "../../design-system/fields.tsx";
import { useLocale } from "../../i18n/locale-context.tsx";
import { beginTotpReplacement, confirmTotpReplacement } from "./platform-api.ts";
import { qrSvg } from "./qr.ts";
import { RecoveryCodesPanel } from "./RecoveryCodesPanel.tsx";
import { refusalText } from "./refusal-text.ts";

type Step =
  | { kind: "ask" }
  | { kind: "scan"; secretBase32: string; otpauthUri: string }
  | { kind: "codes"; codes: string[] };

export function ReplaceAuthenticator({
  onPostpone,
  onReplaced,
}: {
  /** Until the next sign-in. There is deliberately no "never ask again". */
  onPostpone: () => void;
  onReplaced: () => void;
}) {
  const { t } = useLocale();
  const [step, setStep] = useState<Step>({ kind: "ask" });
  const [password, setPassword] = useState("");
  const [visible, setVisible] = useState(false);
  const [code, setCode] = useState("");
  const [failed, setFailed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function start(): Promise<void> {
    setBusy(true);
    setFailed(null);
    const result = await beginTotpReplacement(password);
    setPassword("");
    setVisible(false);
    setBusy(false);
    if (!result.ok) {
      setFailed(refusalText(t, result.code, result.params));
      return;
    }
    setStep({ kind: "scan", secretBase32: result.secretBase32, otpauthUri: result.otpauthUri });
  }

  async function finish(): Promise<void> {
    setBusy(true);
    setFailed(null);
    const result = await confirmTotpReplacement(code);
    setCode("");
    setBusy(false);
    if (!result.ok) {
      setFailed(refusalText(t, result.code, result.params));
      return;
    }
    // The codes are reissued with the secret, because the lost device very likely held the old file.
    setStep({ kind: "codes", codes: result.recoveryCodes });
  }

  if (step.kind === "codes") {
    return (
      <main className="mx-auto max-w-sm p-6" data-testid="replace-authenticator">
        <RecoveryCodesPanel codes={step.codes} onDone={onReplaced} />
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-sm p-6" data-testid="replace-authenticator">
      <h1 className="mb-1 text-lg font-semibold text-ink">{t("recovery.replaceTitle")}</h1>
      <p className="mb-4 text-sm text-ink-muted">{t("recovery.replaceWhy")}</p>

      {step.kind === "ask" ? (
        <div className="flex flex-col gap-3">
          <PasswordField
            label={t("recovery.password")}
            value={password}
            visible={visible}
            toggleLabel={t(visible ? "login.password.hide" : "login.password.show")}
            data-testid="replace-password"
            onToggleVisible={() => setVisible(!visible)}
            onChange={(event) => setPassword(event.target.value)}
          />
          {failed !== null && (
            <p role="alert" className="text-sm text-danger" data-testid="replace-failed">
              {failed}
            </p>
          )}
          <Button loading={busy} data-testid="replace-start" onClick={() => void start()}>
            {t("recovery.replaceStart")}
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-ink">{t("recovery.replaceScan")}</p>
          <div
            className="mx-auto w-44 rounded bg-white p-2"
            data-testid="replace-qr"
            // Generated on this machine from the URI; `qrSvg` emits a fixed shape of rectangles.
            dangerouslySetInnerHTML={{ __html: qrSvg(step.otpauthUri, { scale: 4 }) }}
          />
          <p className="numeric select-all break-all rounded bg-surface-sunken px-2 py-1 text-sm" data-testid="replace-secret">
            {step.secretBase32}
          </p>
          <TextInput
            label={t("recovery.totpCode")}
            numeric
            value={code}
            data-testid="replace-code"
            onChange={(event) => setCode(event.target.value)}
          />
          {failed !== null && (
            <p role="alert" className="text-sm text-danger" data-testid="replace-failed">
              {failed}
            </p>
          )}
          <Button loading={busy} data-testid="replace-confirm" onClick={() => void finish()}>
            {t("platform.totp.submit")}
          </Button>
        </div>
      )}

      {/* Postpone, not dismiss. It returns at the next sign-in, and there is no control that ends it. */}
      <div className="mt-4 border-t border-border pt-3">
        <Button size="sm" variant="ghost" data-testid="replace-postpone" onClick={onPostpone}>
          {t("recovery.postpone")}
        </Button>
        <p className="mt-1 text-xs text-ink-subtle">{t("recovery.postponed")}</p>
      </div>
    </main>
  );
}
