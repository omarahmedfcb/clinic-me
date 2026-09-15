// Upload, preview, replace, remove — one control, used for the logo, the signature and the stamp.
// "Remove" clears the pointer; the stored file is never destroyed (StorageProvider has no delete).

import { useEffect, useRef, useState } from "react";
import { Button } from "../../design-system/Button.tsx";
import { useLocale } from "../../i18n/locale-context.tsx";

interface Props {
  label: string;
  testId: string;
  /** Whether the server says an image is stored. Drives the preview and the remove button. */
  present: boolean;
  load: () => Promise<string | null>;
  upload: (file: File) => Promise<boolean>;
  remove: () => Promise<boolean>;
  onChanged: () => void;
}

export function ImageField({ label, testId, present, load, upload, remove, onChanged }: Props) {
  const { t } = useLocale();
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    let url: string | null = null;
    if (!present) {
      setPreview(null);
      return;
    }
    void load().then((value) => {
      url = value;
      // A leaked object URL holds the bytes for the life of the tab, and this remounts on every save.
      if (cancelled) {
        if (value !== null) URL.revokeObjectURL(value);
        return;
      }
      setPreview(value);
    });
    return () => {
      cancelled = true;
      if (url !== null) URL.revokeObjectURL(url);
    };
  }, [present, load]);

  async function choose(file: File | undefined): Promise<void> {
    if (file === undefined) return;
    setBusy(true);
    setError(null);
    const ok = await upload(file);
    setBusy(false);
    if (input.current !== null) input.current.value = "";
    // The route sniffs the bytes, so this covers "not an image" and "too large" alike — the screen
    // does not restate a rule the server owns.
    if (!ok) {
      setError(t("settings.imageRefused"));
      return;
    }
    onChanged();
  }

  return (
    <section className="grid gap-2" data-testid={testId}>
      <p className="text-sm font-medium text-ink">{label}</p>

      {preview === null ? (
        <p className="text-xs text-ink-muted">{t("settings.noImage")}</p>
      ) : (
        <img
          src={preview}
          alt=""
          data-testid={`${testId}-preview`}
          className="h-20 w-auto rounded border border-border bg-surface p-1"
        />
      )}

      <input
        ref={input}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        data-testid={`${testId}-input`}
        aria-label={label}
        onChange={(event) => void choose(event.target.files?.[0])}
        className="text-sm text-ink-muted"
      />

      <div className="flex items-center gap-2">
        {present && (
          <Button
            size="sm"
            variant="secondary"
            loading={busy}
            data-testid={`${testId}-remove`}
            onClick={() => {
              void (async () => {
                setBusy(true);
                const ok = await remove();
                setBusy(false);
                if (ok) onChanged();
              })();
            }}
          >
            {t("settings.removeImage")}
          </Button>
        )}
        {error !== null && (
          <span role="alert" className="text-xs text-danger">
            {error}
          </span>
        )}
      </div>
    </section>
  );
}
