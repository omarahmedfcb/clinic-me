// Clinic credit on screen — ruling 5. The balance, how it got there, and what may be done with it.
// One component for both surfaces: the patient card refunds, the desk applies. Same ledger.

import { useCallback, useEffect, useState } from "react";
import { Button } from "../../design-system/Button.tsx";
import { Card } from "../../design-system/display.tsx";
import { TextInput } from "../../design-system/fields.tsx";
import { MoneyInput } from "../../design-system/MoneyInput.tsx";
import { formatMinor, intlLocale } from "../../i18n/format.ts";
import { useLocale } from "../../i18n/locale-context.tsx";
import type { TranslationKey } from "../../i18n/strings.ts";
import {
  applyCredit,
  CREDIT_ORIGINS,
  loadCredit,
  refundCredit,
  type CreditLedger,
} from "./credit-api.ts";

type AuthFetch = (path: string, init?: RequestInit) => Promise<Response>;

export function CreditPanel({
  authFetch,
  patientId,
  currency,
  /** Present on the desk: the bill credit may be spent against. Absent on the patient card. */
  chargeId,
  /** What that bill still owes. Credit applied past it is refused, like a payment past it (R-A). */
  chargeBalanceMinor,
  /** The patient card offers the refund; the desk is where money is taken, not given back. */
  allowRefund = false,
  onChanged,
}: {
  authFetch: AuthFetch;
  patientId: string;
  currency: string;
  chargeId?: string;
  chargeBalanceMinor?: number;
  allowRefund?: boolean;
  onChanged?: () => void;
}) {
  const { t, locale } = useLocale();
  const [ledger, setLedger] = useState<CreditLedger | null>(null);
  const [failed, setFailed] = useState(false);
  const [applyMinor, setApplyMinor] = useState<number | null>(null);
  const [refundMinor, setRefundMinor] = useState<number | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<{ code: string; params: Record<string, unknown> } | null>(null);

  const refresh = useCallback(async () => {
    try {
      setLedger(await loadCredit(authFetch, patientId));
      setFailed(false);
    } catch {
      // Never an empty ledger: a refused read is not a zero balance, and money is the worst place
      // to say "nothing here" when what is known is "could not say".
      setLedger(null);
      setFailed(true);
    }
  }, [authFetch, patientId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const money = (minor: number): string => formatMinor(minor, currency, locale);

  const say = (code: string, params: Record<string, unknown>): string =>
    Object.entries(params).reduce(
      (text, [key, value]) =>
        text.replace(`{${key}}`, typeof value === "number" ? money(value) : String(value)),
      t(`refusal.${code}` as TranslationKey),
    );

  // A system-written credit stores a code, not a sentence, so the ledger reads in the interface
  // language; a refund stores what a person typed and is shown exactly as they wrote it.
  const why = (reason: string): string =>
    (CREDIT_ORIGINS as readonly string[]).includes(reason)
      ? t(`credit.origin.${reason}` as TranslationKey)
      : reason;

  const when = (iso: string): string =>
    new Date(iso).toLocaleDateString(intlLocale(locale), { year: "numeric", month: "short", day: "numeric" });

  async function act(run: () => Promise<{ ok: true } | { ok: false; code: string; params: Record<string, unknown> }>) {
    setBusy(true);
    setRefusal(null);
    const result = await run();
    setBusy(false);
    if (!result.ok) {
      setRefusal({ code: result.code, params: result.params });
      return;
    }
    setApplyMinor(null);
    setRefundMinor(null);
    setReason("");
    await refresh();
    onChanged?.();
  }

  if (failed) {
    return (
      <Card title={t("credit.title")}>
        <p role="alert" className="text-sm text-danger" data-testid="credit-failed">
          {t("credit.loadFailed")}
        </p>
      </Card>
    );
  }

  if (ledger === null) {
    return (
      <Card title={t("credit.title")}>
        <p className="text-sm text-ink-muted">{t("common.loading")}</p>
      </Card>
    );
  }

  const balance = ledger.balanceMinor;
  const overCharge =
    applyMinor !== null && chargeBalanceMinor !== undefined && applyMinor > chargeBalanceMinor;

  return (
    <Card title={t("credit.title")}>
      <div data-testid="credit-panel">
        <p className="text-sm text-ink">
          {t("credit.balance")}{" "}
          <span className="numeric font-semibold" data-testid="credit-balance">
            {money(balance)}
          </span>
        </p>
        <p className="mt-1 text-xs text-ink-subtle">{t("credit.neverForfeited")}</p>

        {refusal !== null && (
          <p role="alert" className="mt-2 text-xs text-danger" data-testid="credit-refusal">
            {say(refusal.code, refusal.params)}
          </p>
        )}

        {chargeId !== undefined && balance > 0 && (
          <>
            <div className="mt-3 grid gap-2 sm:grid-cols-[1fr_auto] sm:items-end">
              <MoneyInput
                label={t("credit.applyAmount")}
                currency={currency}
                valueMinor={applyMinor}
                onChangeMinor={setApplyMinor}
                data-testid="credit-apply-amount"
              />
              <Button
                size="sm"
                loading={busy}
                disabled={applyMinor === null || applyMinor <= 0 || overCharge}
                data-testid="credit-apply"
                onClick={() => void act(() => applyCredit(authFetch, chargeId, applyMinor ?? 0))}
              >
                {t("credit.apply")}
              </Button>
            </div>
            {overCharge && (
              <p role="alert" className="mt-2 text-xs text-danger" data-testid="credit-over-charge">
                {t("credit.overCharge").replace("{amount}", money(chargeBalanceMinor ?? 0))}
              </p>
            )}
          </>
        )}

        {allowRefund && balance > 0 && (
          <div className="mt-3 grid gap-2">
            <MoneyInput
              label={t("credit.refundAmount")}
              currency={currency}
              valueMinor={refundMinor}
              onChangeMinor={setRefundMinor}
              data-testid="credit-refund-amount"
            />
            {/* Required, not optional: a refund nobody stated a reason for is the row somebody has
                to explain a year later. The server refuses a blank one either way. */}
            <TextInput
              label={t("credit.refundReason")}
              required
              value={reason}
              data-testid="credit-refund-reason"
              onChange={(event) => setReason(event.target.value)}
            />
            <div>
              <Button
                size="sm"
                variant="secondary"
                loading={busy}
                disabled={refundMinor === null || refundMinor <= 0 || reason.trim() === ""}
                data-testid="credit-refund"
                onClick={() =>
                  void act(() =>
                    refundCredit(authFetch, patientId, { amountMinor: refundMinor ?? 0, reason }),
                  )
                }
              >
                {t("credit.refund")}
              </Button>
            </div>
          </div>
        )}

        {ledger.movements.length === 0 ? (
          <p className="mt-3 text-xs text-ink-muted" data-testid="credit-empty">
            {t("credit.empty")}
          </p>
        ) : (
          <ul className="mt-3 grid gap-1" data-testid="credit-ledger">
            {ledger.movements.map((row) => (
              <li
                key={row.id}
                className="flex flex-wrap items-baseline justify-between gap-2 rounded-lg bg-surface-sunken px-2 py-1.5 text-xs"
              >
                <span className="text-ink">
                  {t(`credit.movement.${row.movement}` as TranslationKey)}
                  {row.receiptNumber !== null && (
                    <span className="numeric ms-2 text-ink-subtle">#{row.receiptNumber}</span>
                  )}
                  {row.reason !== null && <span className="ms-2 text-ink-muted">{why(row.reason)}</span>}
                </span>
                <span className="flex items-baseline gap-3">
                  <span className="numeric text-ink">{money(row.amountMinor)}</span>
                  <span className="numeric text-ink-subtle">{when(row.at)}</span>
                  <span className="text-ink-subtle">{row.actorName}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}
