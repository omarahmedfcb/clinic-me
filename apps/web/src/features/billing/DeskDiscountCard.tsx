// The desk's discount form: amount, reason and the apply button. DeskPage owns the values and the
// request; this renders them.

import { Button } from "../../design-system/Button.tsx";
import { Card } from "../../design-system/display.tsx";
import { TextInput } from "../../design-system/fields.tsx";
import { MoneyInput } from "../../design-system/MoneyInput.tsx";
import { formatMinor } from "../../i18n/format.ts";
import { useLocale } from "../../i18n/locale-context.tsx";
import type { DeskCharge } from "./billing-api.ts";

export function DeskDiscountCard({
  charge,
  currency,
  discountMinor,
  onDiscountMinor,
  reason,
  onReason,
  busy,
  onApply,
}: {
  charge: DeskCharge;
  currency: string;
  discountMinor: number | null;
  onDiscountMinor: (minor: number | null) => void;
  reason: string;
  onReason: (reason: string) => void;
  busy: boolean;
  onApply: () => void;
}) {
  const { t, locale } = useLocale();
  const money = (minor: number): string => formatMinor(minor, currency, locale);

  return (
    <Card title={t("desk.discountTitle")}>
      {charge.discountCeilingMinor !== null && (
        <p className="mb-2 text-xs text-ink-subtle" data-testid="ceiling-hint">
          {t("desk.ceilingHint").replace("{amount}", money(charge.discountCeilingMinor))}
        </p>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <MoneyInput
          label={t("desk.discountAmount")}
          currency={currency}
          valueMinor={discountMinor}
          onChangeMinor={onDiscountMinor}
          data-testid="discount-amount"
        />
        <TextInput
          label={t("desk.discountReason")}
          value={reason}
          onChange={(event) => onReason(event.target.value)}
        />
      </div>
      <div className="mt-3">
        <Button
          size="sm"
          loading={busy}
          // A discount with no reason is refused by the database; saying so before the round
          // trip is kinder than a refusal that arrives after the patient has been told a total.
          disabled={discountMinor === null || reason.trim() === ""}
          data-testid="apply-discount"
          onClick={onApply}
        >
          {t("desk.applyDiscount")}
        </Button>
      </div>
    </Card>
  );
}
