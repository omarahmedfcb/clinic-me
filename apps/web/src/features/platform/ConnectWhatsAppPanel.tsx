// Connecting WhatsApp to a clinic that already exists: pick the kind of number, then Meta's popup.
// The same two choices as the new-clinic form, minus the clinic's own details (they are already saved).

import { useState } from "react";
import { Button } from "../../design-system/Button.tsx";
import { Card } from "../../design-system/display.tsx";
import { useLocale } from "../../i18n/locale-context.tsx";
import type { TranslationKey } from "../../i18n/strings.ts";
import { cx } from "../../lib/cx.ts";
import type { Clinic } from "./platform-api.ts";

export function ConnectWhatsAppPanel({
  clinic,
  busy,
  onConnect,
  onCancel,
}: {
  clinic: Clinic;
  busy: boolean;
  onConnect: (existingNumber: boolean) => void;
  onCancel: () => void;
}) {
  const { t } = useLocale();
  const [numberType, setNumberType] = useState<"new" | "existing" | null>(null);
  // A clinic that already has a number is reconnected with that same number, so there is nothing to choose.
  const reconnecting = clinic.whatsapp?.state === "NEEDS_ATTENTION";

  return (
    <Card
      title={t(reconnecting ? "platform.whatsapp.reconnectTitle" : "platform.whatsapp.connectTitle")}
      subtitle={clinic.name}
    >
      {!reconnecting && (
        <fieldset className="flex flex-col gap-2" disabled={busy}>
          <legend className="mb-2 text-sm font-semibold text-ink">{t("signup.numberType.title")}</legend>
          {(["new", "existing"] as const).map((value) => (
            <label
              key={value}
              className={cx(
                "flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-2.5",
                numberType === value ? "border-primary bg-primary-soft/40" : "border-border",
              )}
            >
              <input
                type="radio"
                name="attach-number-type"
                value={value}
                checked={numberType === value}
                data-testid={`attach-number-type-${value}`}
                onChange={() => setNumberType(value)}
                className="mt-1"
              />
              <span>
                <span className="block text-sm font-medium text-ink">{t(`signup.numberType.${value}.title` as TranslationKey)}</span>
                <span className="block text-xs text-ink-muted">{t(`signup.numberType.${value}.body` as TranslationKey)}</span>
              </span>
            </label>
          ))}
          {numberType === "existing" && (
            <p role="note" className="rounded-lg bg-warning-soft px-3 py-2 text-xs text-warning">
              {t("signup.numberType.existing.note")}
            </p>
          )}
        </fieldset>
      )}
      {reconnecting && <p className="text-sm text-ink-muted">{t("platform.whatsapp.reconnectNote")}</p>}

      <div className="mt-3 flex flex-wrap gap-2">
        <Button
          loading={busy}
          disabled={!reconnecting && numberType === null}
          data-testid="attach-whatsapp"
          onClick={() => onConnect(numberType === "existing")}
        >
          {t(reconnecting ? "platform.whatsapp.reconnect" : "platform.whatsapp.connect")}
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          {t("common.cancel")}
        </Button>
      </div>
    </Card>
  );
}
