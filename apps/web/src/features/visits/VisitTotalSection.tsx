// The visit total before «إنهاء الزيارة», and the adjustment a doctor may make to it — R1.
// The control renders only when the clinic has allowed this doctor to move a price.

import { useEffect, useState } from "react";
import { Button } from "../../design-system/Button.tsx";
import { TextInput } from "../../design-system/fields.tsx";
import { MoneyInput } from "../../design-system/MoneyInput.tsx";
import { formatMinor } from "../../i18n/format.ts";
import { useLocale } from "../../i18n/locale-context.tsx";
import type { TranslationKey } from "../../i18n/strings.ts";
import { loadVisitPricing, saveVisitAdjustment, NO_PRICING, type VisitPricing } from "./pricing-api.ts";

type AuthFetch = (path: string, init?: RequestInit) => Promise<Response>;

export function VisitTotalSection({
  authFetch,
  appointmentId,
  visitId,
  currency,
}: {
  authFetch: AuthFetch;
  appointmentId: string;
  visitId: string;
  currency: string;
}) {
  const { t, locale } = useLocale();
  const [pricing, setPricing] = useState<VisitPricing>(NO_PRICING);
  const [amount, setAmount] = useState<number | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<{ code: string; params: Record<string, unknown> } | null>(null);

  useEffect(() => {
    let cancelled = false;
    void loadVisitPricing(authFetch, appointmentId, visitId).then((value) => {
      if (cancelled) return;
      setPricing(value);
      setAmount(value.adjustmentMinor);
      setReason(value.adjustmentReason ?? "");
    });
    return () => {
      cancelled = true;
    };
  }, [authFetch, appointmentId, visitId]);

  const money = (minor: number): string => formatMinor(minor, currency, locale);

  /** A refusal carries `{ code, params }`; the params are what make the sentence specific. */
  function say(code: string, params: Record<string, unknown>): string {
    const sentence = t(`refusal.${code}` as TranslationKey);
    return Object.entries(params).reduce(
      (text, [key, value]) =>
        text.replace(
          `{${key}}`,
          typeof value === "number" && key !== "actual" ? money(value) : String(value),
        ),
      sentence,
    );
  }

  async function persist(adjustmentMinor: number | null): Promise<void> {
    setBusy(true);
    setFailure(null);
    const saved = await saveVisitAdjustment(authFetch, appointmentId, visitId, {
      adjustmentMinor,
      reason: reason.trim() === "" ? null : reason.trim(),
    });
    setBusy(false);
    if (!saved.ok) {
      setFailure({ code: saved.code, params: saved.params });
      return;
    }
    setPricing(saved.pricing);
    setAmount(saved.pricing.adjustmentMinor);
  }

  // Zero is not an adjustment — the database refuses one, so the button does too.
  const valid = amount !== null && amount !== 0;

  return (
    <section className="grid gap-3 rounded-lg border border-border p-3" data-testid="visit-total">
      <h2 className="text-sm font-semibold text-ink">{t("visitTotal.title")}</h2>

      <dl className="grid gap-1 text-sm">
        <Row label={t("visitTotal.subtotal")} value={money(pricing.subtotalMinor)} />
        {pricing.adjustmentMinor !== null && (
          // Signed by the formatter: `Intl` puts an LRM before its own minus so the sign stays
          // inside the number's left-to-right run, which a concatenated `−` does not.
          <Row
            label={t("visitTotal.adjustment")}
            value={money(pricing.adjustmentMinor)}
            testId="visit-adjustment"
          />
        )}
        <Row label={t("visitTotal.total")} value={money(pricing.totalMinor)} strong testId="visit-total-amount" />
      </dl>

      {pricing.mayAdjust && (
        <div className="grid gap-2 border-t border-border pt-3">
          <p className="text-xs text-ink-muted">{t("visitTotal.hint")}</p>
          {/* The cap named before it is hit, the way the desk names the discount ceiling: a limit
              you only learn by being refused makes people guess. */}
          {pricing.capMinor !== null && (
            <p className="text-xs text-ink-subtle" data-testid="cap-hint">
              {t("visitTotal.capHint").replace("{amount}", money(pricing.capMinor))}
            </p>
          )}
          <div className="grid gap-2 sm:grid-cols-[1fr_2fr_auto] sm:items-end">
            <MoneyInput
              label={t("visitTotal.amount")}
              currency={currency}
              valueMinor={amount}
              onChangeMinor={setAmount}
              data-testid="adjustment-amount"
            />
            <TextInput
              label={t("visitTotal.reason")}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
            <Button
              size="sm"
              variant="secondary"
              loading={busy}
              disabled={!valid}
              data-testid="save-adjustment"
              onClick={() => void persist(amount)}
            >
              {t("visitTotal.save")}
            </Button>
          </div>
          {pricing.adjustmentMinor !== null && (
            <div>
              <Button
                size="sm"
                variant="ghost"
                data-testid="clear-adjustment"
                onClick={() => void persist(null)}
              >
                {t("visitTotal.clear")}
              </Button>
            </div>
          )}
        </div>
      )}

      {failure !== null && (
        <p role="alert" className="text-xs text-danger" data-testid="visit-total-failed">
          {say(failure.code, failure.params)}
        </p>
      )}
    </section>
  );
}

function Row({
  label,
  value,
  strong,
  testId,
}: {
  label: string;
  value: string;
  strong?: boolean;
  testId?: string;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className={strong === true ? "font-semibold text-ink" : "text-ink-muted"}>{label}</dt>
      <dd className={`numeric ${strong === true ? "font-semibold text-ink" : "text-ink"}`} data-testid={testId}>
        {value}
      </dd>
    </div>
  );
}
