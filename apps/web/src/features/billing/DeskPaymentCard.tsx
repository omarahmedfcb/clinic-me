// The desk's collection form and the charge's receipts. DeskPage owns the values, the request and
// which receipt is printing; this renders them.

import { Button } from "../../design-system/Button.tsx";
import { Card } from "../../design-system/display.tsx";
import { Select } from "../../design-system/fields.tsx";
import { MoneyInput } from "../../design-system/MoneyInput.tsx";
import { formatMinor } from "../../i18n/format.ts";
import { useLocale } from "../../i18n/locale-context.tsx";
import type { TranslationKey } from "../../i18n/strings.ts";
import { PAYMENT_METHODS, type DeskCharge, type PaymentMethod, type Receipt } from "./billing-api.ts";

export function DeskPaymentCard({
  charge,
  currency,
  amountMinor,
  onAmountMinor,
  method,
  onMethod,
  overBalance,
  busy,
  onPay,
  onPrint,
}: {
  charge: DeskCharge;
  currency: string;
  amountMinor: number | null;
  onAmountMinor: (minor: number | null) => void;
  method: PaymentMethod;
  onMethod: (method: PaymentMethod) => void;
  overBalance: boolean;
  busy: boolean;
  onPay: () => void;
  onPrint: (receipt: Receipt) => void;
}) {
  const { t, locale } = useLocale();
  const money = (minor: number): string => formatMinor(minor, currency, locale);

  return (
    <Card title={t("desk.paymentTitle")}>
      <p className="mb-2 text-xs text-ink-subtle" data-testid="due-hint">
        {t("desk.dueHint").replace("{amount}", money(charge.balanceMinor))}
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <MoneyInput
          label={t("desk.amount")}
          currency={currency}
          valueMinor={amountMinor}
          onChangeMinor={onAmountMinor}
          data-testid="payment-amount"
        />
        <Select
          label={t("desk.method")}
          value={method}
          options={PAYMENT_METHODS.map((value) => ({
            value,
            label: t(`payment.method.${value}` as TranslationKey),
          }))}
          onChange={(event) => onMethod(event.target.value as PaymentMethod)}
        />
      </div>

      {/* **Refused, not said** — R-A. The server returns 422 either way; the button says so
          first, because a receptionist should learn it before the patient is told a total. */}
      {overBalance && (
        <p role="alert" className="mt-2 text-xs text-danger" data-testid="over-balance">
          {t("desk.overBalance").replace("{amount}", money(charge.balanceMinor))}
        </p>
      )}

      <div className="mt-3">
        <Button
          size="sm"
          loading={busy}
          disabled={amountMinor === null || amountMinor <= 0 || overBalance}
          data-testid="record-payment"
          onClick={onPay}
        >
          {t("desk.recordPayment")}
        </Button>
      </div>

      {charge.receipts.length > 0 && (
        <ul className="mt-4 flex flex-col gap-1 border-t border-border pt-3" data-testid="receipts">
          {charge.receipts.map((receipt) => (
            <li key={receipt.paymentId} className="flex items-baseline justify-between gap-3 text-sm">
              <span className="text-ink">
                <span className="numeric">#{receipt.receiptNumber}</span>
                <span className="ms-2 text-ink-subtle">
                  {t(`payment.method.${receipt.method}` as TranslationKey)}
                </span>
                <span className="numeric ms-2 text-ink-subtle">{receipt.receiptDate}</span>
              </span>
              <span className="flex items-baseline gap-3">
                <span className="numeric text-ink">{money(receipt.amountMinor)}</span>
                <Button
                  size="sm"
                  variant="ghost"
                  data-testid={`print-${receipt.paymentId}`}
                  onClick={() => onPrint(receipt)}
                >
                  {t("print.button")}
                </Button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
