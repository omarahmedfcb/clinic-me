// The desk's payer split: the insurer's share as an amount or a percentage. DeskPage owns the
// values, the conversion and the request; this renders them.

import { Button } from "../../design-system/Button.tsx";
import { Card } from "../../design-system/display.tsx";
import { TextInput } from "../../design-system/fields.tsx";
import { MoneyInput } from "../../design-system/MoneyInput.tsx";
import { formatMinor } from "../../i18n/format.ts";
import { useLocale } from "../../i18n/locale-context.tsx";

/** What the insurer's share is being entered as. The wire only ever carries an amount. */
export type ShareMode = "AMOUNT" | "PERCENT";

export function DeskSplitCard({
  payerName,
  hasCover,
  currency,
  shareMode,
  onShareMode,
  payerShareMinor,
  onPayerShareMinor,
  payerPercent,
  onPayerPercent,
  percentAsMinor,
  shareToSend,
  busy,
  onSet,
}: {
  payerName: string | null | undefined;
  hasCover: boolean;
  currency: string;
  shareMode: ShareMode;
  onShareMode: (mode: ShareMode) => void;
  payerShareMinor: number | null;
  onPayerShareMinor: (minor: number | null) => void;
  payerPercent: string;
  onPayerPercent: (percent: string) => void;
  percentAsMinor: number | null;
  shareToSend: number | null;
  busy: boolean;
  onSet: () => void;
}) {
  const { t, locale } = useLocale();
  const money = (minor: number): string => formatMinor(minor, currency, locale);

  return (
    <Card title={t("desk.splitTitle")} subtitle={payerName ?? t("desk.noPayer")}>
      {!hasCover ? (
        <p className="text-sm text-ink-muted" data-testid="no-cover">
          {t("desk.noPayerExplain")}
        </p>
      ) : (
        <>
          <div className="mb-3 flex gap-2" role="group" aria-label={t("desk.shareMode")}>
            {(["AMOUNT", "PERCENT"] as const).map((mode) => (
              <Button
                key={mode}
                size="sm"
                variant={shareMode === mode ? "secondary" : "ghost"}
                aria-pressed={shareMode === mode}
                data-testid={`share-mode-${mode}`}
                onClick={() => onShareMode(mode)}
              >
                {t(mode === "AMOUNT" ? "desk.shareAsAmount" : "desk.shareAsPercent")}
              </Button>
            ))}
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            {shareMode === "AMOUNT" ? (
              <MoneyInput
                label={t("desk.payerShareAmount")}
                currency={currency}
                valueMinor={payerShareMinor}
                onChangeMinor={onPayerShareMinor}
                data-testid="payer-share-amount"
              />
            ) : (
              <TextInput
                label={t("desk.payerSharePercent")}
                numeric
                inputMode="decimal"
                value={payerPercent}
                data-testid="payer-share-percent"
                onChange={(event) => onPayerPercent(event.target.value)}
              />
            )}
          </div>

          {shareMode === "PERCENT" && percentAsMinor !== null && (
            <p className="mt-2 text-xs text-ink-subtle" data-testid="percent-preview">
              {t("desk.sharePreview")
                .replace("{percent}", payerPercent.trim())
                .replace("{amount}", money(percentAsMinor))}
            </p>
          )}

          <div className="mt-3">
            <Button
              size="sm"
              loading={busy}
              disabled={shareToSend === null}
              data-testid="set-split"
              onClick={onSet}
            >
              {t("desk.setSplit")}
            </Button>
          </div>
        </>
      )}
    </Card>
  );
}
