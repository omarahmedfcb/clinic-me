// «المدفوعات» — R2. One screen, three readings of it: reception works the list, a flagged doctor
// works their own patients' half of it, and an admin reads the day without being able to take it.

import { useEffect, useState } from "react";
import { Button } from "../../design-system/Button.tsx";
import { Card } from "../../design-system/display.tsx";
import { formatMinor } from "../../i18n/format.ts";
import { useLocale } from "../../i18n/locale-context.tsx";
import type { TranslationKey } from "../../i18n/strings.ts";
import { loadPaymentsOverview, type PaymentsOverview } from "./billing-api.ts";

type AuthFetch = (path: string, init?: RequestInit) => Promise<Response>;

export function PaymentsPage({
  authFetch,
  currency,
  onOpenCharge,
}: {
  authFetch: AuthFetch;
  currency: string;
  /** The desk, which is where issuing and collecting actually happen. */
  onOpenCharge: (chargeId: string) => void;
}) {
  const { t, locale } = useLocale();
  const [overview, setOverview] = useState<PaymentsOverview | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void loadPaymentsOverview(authFetch).then((value) => {
      if (cancelled) return;
      setOverview(value);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [authFetch]);

  const money = (minor: number): string => formatMinor(minor, currency, locale);

  if (loading) return <p className="p-6 text-sm text-ink-muted">{t("payments.loading")}</p>;
  if (overview === null) return <p className="p-6 text-sm text-ink-muted">{t("payments.noCharges")}</p>;

  return (
    <main className="mx-auto max-w-4xl" data-testid="payments-page">
      <h1 className="mb-1 text-lg font-semibold text-ink">{t("payments.title")}</h1>
      <p className="mb-4 text-sm text-ink-muted numeric">{overview.day}</p>

      {!overview.mayCollect && (
        <p className="mb-4 text-xs text-ink-muted" data-testid="payments-read-only">
          {t("payments.readOnly")}
        </p>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <Card title={t("payments.collectedToday")}>
          <p className="numeric text-lg font-semibold text-ink" data-testid="collected-today">
            {money(overview.collectedTodayMinor)}
          </p>
          <ul className="mt-3 grid gap-1 text-sm" data-testid="by-method">
            {overview.byMethod.map((row) => (
              <li key={row.method} className="flex items-baseline justify-between gap-3">
                <span className="text-ink-muted">{t(`payment.method.${row.method}` as TranslationKey)}</span>
                <span className="numeric text-ink">{money(row.totalMinor)}</span>
              </li>
            ))}
          </ul>
        </Card>

        <Card title={t("payments.outstanding")}>
          <p className="numeric text-lg font-semibold text-ink" data-testid="outstanding">
            {money(overview.outstandingMinor)}
          </p>
        </Card>
      </div>

      <div className="mt-4">
        <Card title={t("payments.charges")}>
          {overview.charges.length === 0 ? (
            <p className="text-sm text-ink-muted">{t("payments.noCharges")}</p>
          ) : (
            <ul className="grid gap-2" data-testid="payments-charges">
              {overview.charges.map((charge) => (
                <li
                  key={charge.chargeId}
                  className="flex flex-wrap items-baseline justify-between gap-3 rounded-lg bg-surface-sunken px-3 py-2 text-sm"
                >
                  <span className="text-ink">
                    {charge.patientName}
                    <span className="ms-2 text-xs text-ink-subtle">{charge.doctorName}</span>
                  </span>
                  <span className="flex items-baseline gap-3">
                    <span className="text-xs text-ink-muted">{t("payments.paid")}</span>
                    <span className="numeric text-ink">{money(charge.paidMinor)}</span>
                    <span className="text-xs text-ink-muted">{t("payments.balance")}</span>
                    <span className="numeric font-semibold text-ink">{money(charge.balanceMinor)}</span>
                    {/* The desk opens from here (R2). An admin has no button, because the desk is
                        where money is taken and an admin may not take it. */}
                    {overview.mayCollect && (
                      <Button
                        size="sm"
                        variant="ghost"
                        data-testid={`open-${charge.chargeId}`}
                        onClick={() => onOpenCharge(charge.chargeId)}
                      >
                        {t("payments.open")}
                      </Button>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <div className="mt-4">
        <Card title={t("payments.receipts")}>
          {overview.receipts.length === 0 ? (
            <p className="text-sm text-ink-muted">{t("payments.noReceipts")}</p>
          ) : (
            <ul className="grid gap-1 text-sm" data-testid="payments-receipts">
              {overview.receipts.map((receipt) => (
                <li key={receipt.paymentId} className="flex flex-wrap items-baseline justify-between gap-3">
                  <span className="text-ink">
                    <span className="text-xs text-ink-muted">{t("payments.receiptNo")}</span>
                    <span className="numeric ms-1">{receipt.receiptNumber}</span>
                    <span className="ms-2">{receipt.patientName}</span>
                  </span>
                  <span className="flex items-baseline gap-3">
                    <span className="text-xs text-ink-subtle">
                      {t(`payment.method.${receipt.method}` as TranslationKey)}
                    </span>
                    <span className="numeric text-ink">{money(receipt.amountMinor)}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      {/* R1's oversight, in the place the ruling puts it: the adjustments are what an admin reads
          instead of a queue of things waiting for them. */}
      <div className="mt-4">
        <Card title={t("payments.adjustments")}>
          {overview.adjustments.length === 0 ? (
            <p className="text-sm text-ink-muted">{t("payments.noAdjustments")}</p>
          ) : (
            <ul className="grid gap-1 text-sm" data-testid="payments-adjustments">
              {overview.adjustments.map((row) => (
                <li key={row.visitId} className="flex flex-wrap items-baseline justify-between gap-3">
                  <span className="text-ink">
                    {row.patientName}
                    <span className="ms-2 text-xs text-ink-subtle">{row.doctorName}</span>
                    {row.reason !== null && <span className="ms-2 text-xs text-ink-muted">{row.reason}</span>}
                  </span>
                  {/* Signed by the formatter, never by concatenation: a `−` glued in front sits
                      outside the number's own bidi run and detaches from it in Arabic. */}
                  <span className="numeric text-ink">{money(row.amountMinor)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <div className="mt-4">
        <Card title={t("payments.aboveCeiling")}>
          {overview.aboveCeiling.length === 0 ? (
            <p className="text-sm text-ink-muted">{t("payments.noAboveCeiling")}</p>
          ) : (
            <ul className="grid gap-1 text-sm" data-testid="payments-above-ceiling">
              {overview.aboveCeiling.map((row) => (
                <li key={row.chargeId} className="flex flex-wrap items-baseline justify-between gap-3">
                  <span className="text-ink">
                    {row.patientName}
                    {row.authorisedBy !== null && (
                      <span className="ms-2 text-xs text-ink-subtle">{row.authorisedBy}</span>
                    )}
                  </span>
                  <span className="numeric text-ink">{money(-row.discountMinor)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </main>
  );
}
