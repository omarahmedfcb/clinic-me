// Attachments on the live visit screen — PR 9, pulled forward 2026-09-09. Upload from a file or the
// camera, list with type and date, open, archive. Clinical content: the doctor's screen only.

import { useEffect, useRef, useState } from "react";
import { Button } from "../../design-system/Button.tsx";
import { Select, TextInput } from "../../design-system/fields.tsx";
import { intlLocale } from "../../i18n/format.ts";
import { useLocale } from "../../i18n/locale-context.tsx";
import type { TranslationKey } from "../../i18n/strings.ts";
import {
  ATTACHMENT_CATEGORIES,
  archiveAttachment,
  listAttachments,
  uploadAttachment,
  type AttachmentCategory,
} from "./attachments-api.ts";
import { loadPatientHeader } from "./draft-api.ts";
import { downloadAttachment, type VisitAttachment } from "./visit-api.ts";

type AuthFetch = (path: string, init?: RequestInit) => Promise<Response>;

/** Rounded to one decimal above a megabyte — the same rule `VisitDetailView` uses. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function AttachmentsSection({
  authFetch,
  appointmentId,
  visitId,
}: {
  authFetch: AuthFetch;
  appointmentId: string;
  visitId: string | null;
}) {
  const { t, locale } = useLocale();
  // Resolved here rather than drilled down, which is what `PrintSection` does with the same header:
  // the attachment routes are patient-scoped and every other route on this screen is appointment-scoped.
  const [patientId, setPatientId] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<VisitAttachment[]>([]);

  useEffect(() => {
    let cancelled = false;
    void loadPatientHeader(authFetch, appointmentId).then((header) => {
      if (!cancelled) setPatientId(header?.patientId ?? null);
    });
    return () => {
      cancelled = true;
    };
  }, [authFetch, appointmentId]);
  const [category, setCategory] = useState<AttachmentCategory>("LAB");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const cameraInput = useRef<HTMLInputElement>(null);

  const refresh = async (): Promise<void> => {
    if (patientId === null) return;
    setAttachments(await listAttachments(authFetch, patientId));
  };

  useEffect(() => {
    if (patientId === null) return;
    let cancelled = false;
    void listAttachments(authFetch, patientId).then((value) => {
      if (!cancelled) setAttachments(value);
    });
    return () => {
      cancelled = true;
    };
  }, [authFetch, patientId]);

  async function onFileChosen(input: HTMLInputElement): Promise<void> {
    const file = input.files?.[0];
    // Cleared immediately so choosing the same file twice still fires a change event — otherwise a
    // failed upload cannot be retried without picking a different file.
    input.value = "";
    if (file === undefined || patientId === null) return;

    setBusy(true);
    setFailure(null);
    const result = await uploadAttachment(authFetch, patientId, {
      file,
      category,
      description: description.trim() === "" ? null : description.trim(),
      visitId,
    });
    setBusy(false);

    if (!result.ok) {
      setFailure(result.code);
      return;
    }
    setDescription("");
    await refresh();
  }

  async function onArchive(attachment: VisitAttachment): Promise<void> {
    setBusy(true);
    const ok = await archiveAttachment(authFetch, attachment.id);
    setBusy(false);
    if (!ok) {
      setFailure("INTERNAL");
      return;
    }
    await refresh();
  }

  return (
    <section className="rounded-xl border border-border bg-surface p-4" data-testid="attachments">
      <h3 className="mb-3 text-sm font-semibold text-ink">{t("attachments.title")}</h3>

      {/* The API sends `{ code, params }` and the client owns the wording; every code these routes
          can return is worded, which `attachment-refusals-are-worded.spec.ts` enforces. */}
      {failure !== null && (
        <p role="alert" className="mb-3 text-xs text-danger" data-testid="attachment-failure">
          {t(`refusal.${failure}` as TranslationKey)}
        </p>
      )}

      <div className="mb-4 grid gap-3 sm:grid-cols-2">
        <Select
          label={t("attachments.category")}
          value={category}
          options={ATTACHMENT_CATEGORIES.map((value) => ({
            value,
            label: t(`attachments.category.${value}` as TranslationKey),
          }))}
          onChange={(event) => setCategory(event.target.value as AttachmentCategory)}
        />
        <TextInput
          label={t("attachments.description")}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
        />
      </div>

      {/* Two inputs rather than one, because `capture` is a request for the camera and cannot be
          toggled per click. On a laptop the second opens a file picker, which is harmless; on a
          phone it opens the camera, which is how a scan or a lab slip actually arrives. */}
      <input
        ref={fileInput}
        type="file"
        className="hidden"
        data-testid="attachment-file-input"
        accept="image/jpeg,image/png,image/webp,application/pdf"
        onChange={(event) => void onFileChosen(event.currentTarget)}
      />
      <input
        ref={cameraInput}
        type="file"
        className="hidden"
        data-testid="attachment-camera-input"
        accept="image/*"
        capture="environment"
        onChange={(event) => void onFileChosen(event.currentTarget)}
      />

      <div className="mb-4 flex gap-2">
        <Button size="sm" loading={busy} data-testid="attachment-upload" onClick={() => fileInput.current?.click()}>
          {t("attachments.upload")}
        </Button>
        <Button
          size="sm"
          variant="secondary"
          loading={busy}
          data-testid="attachment-camera"
          onClick={() => cameraInput.current?.click()}
        >
          {t("attachments.camera")}
        </Button>
      </div>

      {attachments.length === 0 ? (
        <p className="text-sm text-ink-subtle">{t("attachments.none")}</p>
      ) : (
        <ul className="flex flex-col gap-2" data-testid="attachment-list">
          {attachments.map((attachment) => (
            <li
              key={attachment.id}
              data-testid={`attachment-${attachment.id}`}
              className="flex items-center justify-between gap-3 rounded border border-border p-2"
            >
              <div className="flex min-w-0 flex-col">
                {/* `break-all`, not truncate: an Arabic filename cut in the middle is
                    unidentifiable, and these are how a doctor tells two scans apart. */}
                <span className="break-all text-sm text-ink">{attachment.fileName}</span>
                <span className="text-xs text-ink-subtle">
                  {t(`attachments.category.${attachment.category}` as TranslationKey)}
                  <span className="numeric ms-2">
                    {new Date(attachment.createdAt).toLocaleDateString(intlLocale(locale))}
                  </span>
                  <span className="numeric ms-2">{formatBytes(attachment.sizeBytes)}</span>
                  {attachment.archivedAt !== null && (
                    <span className="ms-2 text-warning">{t("visit.attachments.archived")}</span>
                  )}
                </span>
              </div>
              <div className="flex shrink-0 gap-2">
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => void downloadAttachment(authFetch, attachment.id, attachment.fileName)}
                >
                  {t("visit.attachments.download")}
                </Button>
                {attachment.archivedAt === null && (
                  <Button
                    size="sm"
                    variant="secondary"
                    data-testid={`archive-${attachment.id}`}
                    onClick={() => void onArchive(attachment)}
                  >
                    {t("attachments.archive")}
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
