// The desk's charge: its lines and totals, and the button that prints the invoice. Display only;
// DeskPage owns the charge and every action.

import { Button } from "../../design-system/Button.tsx";
import { Card } from "../../design-system/display.tsx";
import { formatMinor } from "../../i18n/format.ts";
import { useLocale } from "../../i18n/locale-context.tsx";
import type { DeskCharge } from "./billing-api.ts";

export function DeskChargeCard({
  charge,
  currency,
  onPrintInvoice,
}: {
  charge: DeskCharge;
  currency: string;
  onPrintInvoice: () => void;
}) {
  const { t, locale } = useLocale();
  const money = (minor: number): string => formatMinor(minor, currency, locale);

  return (
    <Card
      title={t("desk.lines")}
      actions={
        <Button size="sm" variant="secondary" data-testid="print-invoice" onClick={onPrintInvoice}>
          {t("desk.printInvoice")}
        </Button>
      }
    >
      <ul className="flex flex-col gap-1" data-testid="charge-lines">
        {charge.lines.map((line) => (
          <li key={line.id} className="flex items-baseline justify-between gap-3 text-sm">
            <span className="text-ink">
              {line.nameSnapshot}
              {line.quantity > 1 && <span className="numeric ms-2 text-ink-subtle">×{line.quantity}</span>}
              {line.adjustedBy !== null && (
                <span className="ms-2 text-xs text-ink-subtle">
                  {`${t("desk.adjustedBy")} ${line.adjustedBy}`}
                  {line.adjustmentReason !== null && ` — ${line.adjustmentReason}`}
                </span>
              )}
            </span>
            <span className="numeric text-ink">{money(line.unitPriceMinor * line.quantity)}</span>
          </li>
        ))}
      </ul>

      {/*
        **Negative amounts are formatted as negative numbers, never signed by hand.** `Intl` puts
        an LRM immediately before its own minus so the sign stays inside the number's
        left-to-right run; a `−` concatenated in front sits outside that run and, in an Arabic
        paragraph, renders detached from the figure it belongs to.
      */}
      <dl className="mt-4 grid gap-1 border-t border-border pt-3 text-sm">
        <Row label={t("desk.subtotal")} value={money(charge.subtotalMinor)} />
        {charge.discountMinor > 0 && (
          <Row label={t("desk.discount")} value={money(-charge.discountMinor)} testId="discount-row" />
        )}
        {charge.payerShareMinor > 0 && (
          <Row label={t("desk.payerShare")} value={money(-charge.payerShareMinor)} />
        )}
        <Row label={t("desk.patientShare")} value={money(charge.patientShareMinor)} />
        <Row label={t("desk.paid")} value={money(charge.paidMinor)} />
        <Row label={t("desk.balance")} value={money(charge.balanceMinor)} strong testId="balance" />
      </dl>
    </Card>
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
      <dd
        className={`numeric ${strong === true ? "font-semibold text-ink" : "text-ink"}`}
        data-testid={testId}
      >
        {value}
      </dd>
    </div>
  );
}
