// One print button for one sheet, placed next to the data that sheet prints.

import { Button } from "../../design-system/Button.tsx";
import { useLocale } from "../../i18n/locale-context.tsx";
import type { TranslationKey } from "../../i18n/strings.ts";
import { requestPrint, type SheetKind } from "./print-sheet-event.ts";

export function PrintSheetButton({
  kind,
  disabled,
  loading,
  onBeforePrint,
}: {
  kind: SheetKind;
  disabled?: boolean;
  loading?: boolean;
  /** Runs first, and may refuse: the sick-leave section saves its form before printing it. */
  onBeforePrint?: () => Promise<boolean>;
}) {
  const { t } = useLocale();
  return (
    <Button
      size="sm"
      variant="secondary"
      disabled={disabled}
      loading={loading}
      data-testid={`print-${kind}`}
      onClick={() => {
        void (async () => {
          if (onBeforePrint !== undefined && !(await onBeforePrint())) return;
          requestPrint(kind);
        })();
      }}
    >
      {t(`print.button.${kind}` as TranslationKey)}
    </Button>
  );
}
