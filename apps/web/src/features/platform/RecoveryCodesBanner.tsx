// "N recovery codes left — regenerate", shown persistently once the supply runs low.
// Zero is the ordinary state of every operator enrolled before 2026-09-16, and this is their path.

import { useState } from "react";
import { Button } from "../../design-system/Button.tsx";
import { PasswordField, TextInput } from "../../design-system/fields.tsx";
import { useLocale } from "../../i18n/locale-context.tsx";
import { regenerateRecoveryCodes } from "./platform-api.ts";
import { RecoveryCodesPanel } from "./RecoveryCodesPanel.tsx";
import { refusalText } from "./refusal-text.ts";

/** Below this the banner appears and stays. Matches LOW_REMAINING_THRESHOLD on the server. */
const LOW = 3;

export function RecoveryCodesBanner({ remaining, onRegenerated }: { remaining: number; onRegenerated: () => void }) {
  const { t } = useLocale();
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [visible, setVisible] = useState(false);
  const [totp, setTotp] = useState("");
  const [codes, setCodes] = useState<string[] | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (remaining >= LOW && codes === null) return null;

  async function regenerate(): Promise<void> {
    setBusy(true);
    setFailed(null);
    const result = await regenerateRecoveryCodes(password, totp);
    setPassword("");
    setVisible(false);
    setTotp("");
    setBusy(false);
    if (!result.ok) {
      setFailed(refusalText(t, result.code, result.params));
      return;
    }
    setCodes(result.recoveryCodes);
  }

  if (codes !== null) {
    return (
      <div className="mb-3">
        <RecoveryCodesPanel
          codes={codes}
          title={t("recovery.regenerateTitle")}
          onDone={() => {
            setCodes(null);
            setOpen(false);
            onRegenerated();
          }}
        />
      </div>
    );
  }

  return (
    <div className="mb-3 rounded-lg border border-warning bg-warning-soft p-3" data-testid="recovery-banner">
      <p className="text-sm text-ink">
        {remaining === 0 ? t("recovery.none") : t("recovery.remaining").replace("{n}", String(remaining))}
      </p>

      {!open ? (
        <div className="mt-2">
          <Button size="sm" variant="secondary" data-testid="recovery-banner-open" onClick={() => setOpen(true)}>
            {t("recovery.regenerate")}
          </Button>
        </div>
      ) : (
        <div className="mt-2 grid gap-2">
          <p className="text-xs text-ink-subtle">{t("recovery.regenerateHint")}</p>
          <PasswordField
            label={t("recovery.password")}
            value={password}
            visible={visible}
            toggleLabel={t(visible ? "login.password.hide" : "login.password.show")}
            data-testid="regenerate-password"
            onToggleVisible={() => setVisible(!visible)}
            onChange={(event) => setPassword(event.target.value)}
          />
          <TextInput
            label={t("recovery.totpCode")}
            numeric
            value={totp}
            data-testid="regenerate-totp"
            onChange={(event) => setTotp(event.target.value)}
          />
          {failed !== null && (
            <p role="alert" className="text-sm text-danger" data-testid="regenerate-failed">
              {failed}
            </p>
          )}
          <div className="flex gap-2">
            <Button size="sm" loading={busy} data-testid="regenerate-confirm" onClick={() => void regenerate()}>
              {t("recovery.regenerate")}
            </Button>
            <Button size="sm" variant="ghost" data-testid="regenerate-cancel" onClick={() => setOpen(false)}>
              {t("recovery.resetCancel")}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
