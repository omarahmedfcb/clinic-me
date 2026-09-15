// The forced password change — Phase 5 PR 10. Shown when the account holds a temporary password.
// The server refuses every other route until this succeeds; this screen is the courtesy, not the gate.

import { useState } from "react";
import { Button } from "../../design-system/Button.tsx";
import { Card } from "../../design-system/display.tsx";
import { PasswordField } from "../../design-system/fields.tsx";
import { useLocale } from "../../i18n/locale-context.tsx";
import type { TranslationKey } from "../../i18n/strings.ts";
import { changePassword } from "./staff-api.ts";

type AuthFetch = (path: string, init?: RequestInit) => Promise<Response>;

const MINIMUM = 12;

export function ChangePasswordScreen({
  authFetch,
  onChanged,
}: {
  authFetch: AuthFetch;
  /** Hands back the fresh access token: the old session is revoked by the change. */
  onChanged: (accessToken: string) => void;
}) {
  const { t } = useLocale();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const tooShort = next !== "" && next.length < MINIMUM;
  const mismatch = confirm !== "" && confirm !== next;
  const ready = current !== "" && next.length >= MINIMUM && confirm === next;

  async function save(): Promise<void> {
    setBusy(true);
    setFailure(null);
    const result = await changePassword(authFetch, { currentPassword: current, newPassword: next });
    setBusy(false);
    if (!result.ok) {
      setFailure(t(`refusal.${result.code}` as TranslationKey));
      return;
    }
    onChanged(result.accessToken);
  }

  return (
    <main className="mx-auto mt-16 max-w-md" data-testid="change-password">
      <Card title={t("password.title")}>
        <p className="mb-4 text-sm text-ink-muted">{t("password.intro")}</p>
        <div className="grid gap-3">
          <PasswordField
            label={t("password.current")}
            toggleLabel={t("login.password.show")}
            visible={visible}
            onToggleVisible={() => setVisible(!visible)}
            value={current}
            data-testid="current-password"
            onChange={(event) => setCurrent(event.target.value)}
          />
          <PasswordField
            label={t("password.new")}
            toggleLabel={t("login.password.show")}
            visible={visible}
            onToggleVisible={() => setVisible(!visible)}
            value={next}
            error={tooShort ? t("password.tooShort") : undefined}
            data-testid="new-password"
            onChange={(event) => setNext(event.target.value)}
          />
          <PasswordField
            label={t("password.confirm")}
            toggleLabel={t("login.password.show")}
            visible={visible}
            onToggleVisible={() => setVisible(!visible)}
            value={confirm}
            error={mismatch ? t("password.mismatch") : undefined}
            data-testid="confirm-password"
            onChange={(event) => setConfirm(event.target.value)}
          />
          <Button loading={busy} disabled={!ready} data-testid="save-password" onClick={() => void save()}>
            {t("password.save")}
          </Button>
          {failure !== null && (
            <p role="alert" className="text-xs text-danger" data-testid="password-failure">
              {failure}
            </p>
          )}
        </div>
      </Card>
    </main>
  );
}
