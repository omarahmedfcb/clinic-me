// The vendor's own people — 2a. Seating one is the OWNER's act, and the screen offers the button
// only to an OWNER, because a button that is always refused is a worse answer than no button.

import { useCallback, useEffect, useState } from "react";
import { Button } from "../../design-system/Button.tsx";
import { Card, DataTable, type Column } from "../../design-system/display.tsx";
import { Select, TextInput } from "../../design-system/fields.tsx";
import { useLocale } from "../../i18n/locale-context.tsx";
import type { TranslationKey } from "../../i18n/strings.ts";
import {
  createOperator,
  loadOperators,
  resetOperatorTotp,
  setOperatorRole,
  type Operator,
} from "./platform-api.ts";
import { refusalText } from "./refusal-text.ts";

const ROLES = ["OWNER", "SUPPORT", "SALES", "FINANCE"] as const;

export function OperatorsPanel({
  me,
  onIssued,
  onChanged,
}: {
  me: { userId: string; platformRole: string };
  onIssued: (who: string, password: string) => void;
  onChanged: () => void;
}) {
  const { t } = useLocale();
  const [operators, setOperators] = useState<Operator[] | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [fullName, setFullName] = useState("");
  const [phone, setPhone] = useState("");
  const [role, setRole] = useState<string>("SUPPORT");
  /** The operator whose factor is being cleared, and the reason the trail will carry. */
  const [resetting, setResetting] = useState<{ userId: string; reason: string } | null>(null);

  const isOwner = me.platformRole === "OWNER";

  const refresh = useCallback(async () => {
    setOperators(await loadOperators());
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const act = async (run: () => Promise<{ ok: true } | { ok: false; code: string; params: Record<string, unknown> }>) => {
    setBusy(true);
    setRefusal(null);
    const result = await run();
    setBusy(false);
    if (!result.ok) {
      setRefusal(refusalText(t, result.code, result.params));
      return false;
    }
    await refresh();
    onChanged();
    return true;
  };

  const columns: Column<Operator>[] = [
    {
      key: "name",
      header: t("platform.operator"),
      render: (row) => (
        <span>
          <span className="block text-ink">{row.fullName}</span>
          <span className="numeric block text-xs text-ink-subtle">{row.phoneE164}</span>
        </span>
      ),
    },
    {
      key: "role",
      header: t("platform.operatorRole"),
      render: (row) =>
        isOwner && row.userId !== me.userId ? (
          <Select
            label=""
            value={row.platformRole}
            data-testid={`role-${row.userId}`}
            options={ROLES.map((value) => ({ value, label: t(`platform.role.${value}` as TranslationKey) }))}
            onChange={(event) => void act(() => setOperatorRole(row.userId, event.target.value))}
          />
        ) : (
          <span className="text-ink">{t(`platform.role.${row.platformRole}` as TranslationKey)}</span>
        ),
    },
    {
      key: "totp",
      header: t("platform.secondFactor"),
      render: (row) => (
        // The one thing an operator's row must say plainly: an account without it cannot sign in,
        // so "not enrolled" is a state somebody has to act on rather than a detail.
        <span className={row.totpEnrolled ? "text-ink" : "text-danger"}>
          {t(row.totpEnrolled ? "platform.totp.enrolled" : "platform.totp.notEnrolled")}
        </span>
      ),
    },
    {
      key: "actions",
      header: "",
      render: (row) =>
        isOwner && row.totpEnrolled ? (
          <Button
            size="sm"
            variant="ghost"
            loading={busy}
            data-testid={`reset-totp-${row.userId}`}
            // Opens the reason form rather than acting. Clearing somebody's only second factor is a
            // break-glass act, and the trail records why under the resetter's name.
            onClick={() => setResetting({ userId: row.userId, reason: "" })}
          >
            {t("platform.totp.reset")}
          </Button>
        ) : null,
    },
  ];

  return (
    <Card title={t("platform.operators")} subtitle={t("platform.operatorsHint")} padded={false}>
      {refusal !== null && (
        <p role="alert" className="px-4 pt-3 text-sm text-danger" data-testid="operators-refusal">
          {refusal}
        </p>
      )}

      <div data-testid="operator-list">
        <DataTable
          columns={columns}
          rows={operators ?? []}
          rowKey={(row) => row.userId}
          caption={t("platform.operators")}
        />
      </div>

      {isOwner && (
        <div className="border-t border-border p-4">
          <div className="grid gap-2 sm:grid-cols-3">
            <TextInput label={t("platform.operatorName")} value={fullName} data-testid="operator-name" onChange={(e) => setFullName(e.target.value)} />
            <TextInput label={t("platform.operatorPhone")} numeric type="tel" inputMode="tel" value={phone} data-testid="operator-phone" onChange={(e) => setPhone(e.target.value)} />
            <Select
              label={t("platform.operatorRole")}
              value={role}
              data-testid="operator-role"
              options={ROLES.map((value) => ({ value, label: t(`platform.role.${value}` as TranslationKey) }))}
              onChange={(event) => setRole(event.target.value)}
            />
          </div>
          <div className="mt-2">
            <Button
              size="sm"
              loading={busy}
              disabled={fullName.trim() === "" || phone.trim() === ""}
              data-testid="seat-operator"
              onClick={() =>
                void act(async () => {
                  const result = await createOperator({ fullName, phone, operatorRole: role });
                  if (result.ok) {
                    onIssued(fullName, result.temporaryPassword);
                    setFullName("");
                    setPhone("");
                  }
                  return result;
                })
              }
            >
              {t("platform.seatOperator")}
            </Button>
          </div>
        </div>
      )}

      {resetting !== null && (
        <div className="mt-3 grid gap-2 rounded-lg border border-warning p-3" data-testid="reset-totp-form">
          <TextInput
            label={t("recovery.resetReason")}
            hint={t("recovery.resetReasonHint")}
            value={resetting.reason}
            data-testid="reset-totp-reason"
            onChange={(event) => setResetting({ ...resetting, reason: event.target.value })}
          />
          <div className="flex gap-2">
            <Button
              size="sm"
              loading={busy}
              // The server requires it too; this only stops a pointless round trip.
              disabled={resetting.reason.trim().length < 3}
              data-testid="reset-totp-confirm"
              onClick={() =>
                void act(async () => {
                  const result = await resetOperatorTotp(resetting.userId, resetting.reason.trim());
                  if (result.ok) setResetting(null);
                  return result;
                })
              }
            >
              {t("recovery.resetConfirm")}
            </Button>
            <Button size="sm" variant="ghost" data-testid="reset-totp-cancel" onClick={() => setResetting(null)}>
              {t("recovery.resetCancel")}
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}
