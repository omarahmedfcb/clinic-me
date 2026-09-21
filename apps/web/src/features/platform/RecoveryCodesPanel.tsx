// Recovery codes, shown exactly once. There is no route that reads them back, so this panel is the
// only moment they exist outside a hash — which is why it insists on copy or download before moving on.

import { useState } from "react";
import { Button } from "../../design-system/Button.tsx";
import { useLocale } from "../../i18n/locale-context.tsx";

/**
 * The one-time display.
 *
 * `onDone` is only enabled after the operator has copied or downloaded, because the alternative is
 * an operator who clicks past the only screen that will ever show these and is then one lost phone
 * away from needing another operator to let them back in.
 */
export function RecoveryCodesPanel({
  codes,
  onDone,
  title,
}: {
  codes: string[];
  onDone: () => void;
  title?: string;
}) {
  const { t } = useLocale();
  const [taken, setTaken] = useState(false);

  const asText = codes.join("\n");

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(asText);
      setTaken(true);
    } catch {
      // A blocked clipboard is not a reason to trap somebody on this screen: the codes are on it.
      setTaken(true);
    }
  }

  function download(): void {
    const blob = new Blob([`${asText}\n`], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "clinic-os-recovery-codes.txt";
    link.click();
    URL.revokeObjectURL(url);
    setTaken(true);
  }

  return (
    <div className="grid gap-3 rounded-lg border border-border p-4" data-testid="recovery-codes">
      <div>
        <h2 className="text-sm font-semibold text-ink">{title ?? t("recovery.title")}</h2>
        <p className="mt-1 text-xs text-ink-subtle">{t("recovery.shownOnce")}</p>
      </div>

      <ul className="grid grid-cols-2 gap-2" data-testid="recovery-codes-list">
        {codes.map((code) => (
          <li
            key={code}
            className="rounded bg-surface-sunken px-2 py-1 text-center font-mono text-sm [direction:ltr]"
          >
            {code}
          </li>
        ))}
      </ul>

      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="secondary" data-testid="recovery-copy" onClick={() => void copy()}>
          {t("recovery.copy")}
        </Button>
        <Button size="sm" variant="secondary" data-testid="recovery-download" onClick={download}>
          {t("recovery.download")}
        </Button>
        <Button size="sm" disabled={!taken} data-testid="recovery-done" onClick={onDone}>
          {t("recovery.done")}
        </Button>
      </div>

      {!taken && <p className="text-xs text-warning">{t("recovery.takeThemFirst")}</p>}
    </div>
  );
}
