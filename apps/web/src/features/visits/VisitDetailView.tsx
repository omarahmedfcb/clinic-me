import { useEffect, useState } from "react";
import { Button } from "../../design-system/Button.tsx";
import { Spinner } from "../../design-system/Spinner.tsx";
import { useToast } from "../../design-system/Toast.tsx";
import { intlLocale } from "../../i18n/format.ts";
import { useLocale } from "../../i18n/locale-context.tsx";
import { useSession } from "../auth/session.tsx";
import {
  downloadAttachment,
  loadVisit,
  type VisitAttachment,
  type VisitDetail,
  type VisitRevision,
} from "./visit-api.ts";

/**
 * One past visit, opened from the history list — `PHASE-4.md` Q18.
 *
 * **This is the screen the defect was about.** `ClinicalSection` rendered history as a list of
 * dates and one-line summaries that could not be opened, because until `GET /visits/:id` existed
 * there was nowhere to open them to. History that cannot be opened is a list of dates.
 *
 * ## Why a refusal is rendered rather than thrown
 *
 * A doctor opening a visit belonging to a patient they have never treated gets 409, and that is the
 * rule working — R-B, 2026-09-14, opened this to a doctor's own past patients and to nobody else's.
 * Showing a broken screen would report a correct refusal as a fault and send them looking for one. So
 * it renders as a sentence, the same treatment `detail.history.locked` already gives the presence
 * rule on the history list.
 *
 * ## Empty sections say they are empty
 *
 * A visit where the doctor recorded a diagnosis and nothing else must not render as though the
 * examination section did not exist. A missing heading reads as "not part of this record"; an
 * explicit "nothing was recorded here" reads as what it is. That distinction is the same one
 * `ClinicalSection` makes for allergies, and it matters more the older the record gets.
 */
export function VisitDetailView({
  appointmentId,
  onBack,
}: {
  appointmentId: string;
  onBack: () => void;
}) {
  const { t, locale } = useLocale();
  const { authFetch } = useSession();
  const { push } = useToast();

  const [visit, setVisit] = useState<VisitDetail | null>(null);
  const [failure, setFailure] = useState<"NOT_PRESENT" | "NOT_FOUND" | "ERROR" | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setVisit(null);
    setFailure(null);
    void (async () => {
      const result = await loadVisit(authFetch, appointmentId);
      if (cancelled) return;
      if (result.ok) setVisit(result.visit);
      else setFailure(result.reason);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [appointmentId, authFetch]);

  const onDownload = async (attachment: VisitAttachment): Promise<void> => {
    const result = await downloadAttachment(authFetch, attachment.id, attachment.fileName);
    if (!result.ok) push("error", t("visit.attachments.downloadFailed"));
  };

  return (
    <section className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <Button size="sm" variant="secondary" onClick={onBack}>
          {t("visit.back")}
        </Button>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-ink-muted">
          <Spinner />
          <span>{t("visit.loading")}</span>
        </div>
      ) : failure !== null ? (
        <p className="text-sm text-ink-muted">
          {failure === "NOT_PRESENT"
            ? t("visit.notPermitted")
            : failure === "NOT_FOUND"
              ? t("visit.notFound")
              : t("visit.loadFailed")}
        </p>
      ) : visit !== null ? (
        <>
          <header className="flex flex-col gap-1">
            <h4 className="text-sm font-semibold text-ink">{t("visit.title")}</h4>
            <span className="numeric text-xs text-ink-subtle">
              {new Date(visit.completedAt ?? visit.createdAt).toLocaleDateString(intlLocale(locale))}
            </span>
          </header>

          <Field label={t("visit.complaint")} value={visit.complaint} emptyLabel={t("visit.empty")} />
          <Field label={t("visit.medicalHistory")} value={visit.medicalHistory} emptyLabel={t("visit.empty")} />
          <Field label={t("visit.examination")} value={visit.examination} emptyLabel={t("visit.empty")} />
          <Field label={t("detail.diagnosis")} value={visit.diagnosis} emptyLabel={t("visit.empty")} />
          <Field label={t("visit.treatmentPlan")} value={visit.treatmentPlan} emptyLabel={t("visit.empty")} />
          <Field label={t("visit.doctorNotes")} value={visit.doctorNotes} emptyLabel={t("visit.empty")} />

          {visit.followUpDate !== null && (
            <div>
              <h5 className="text-xs font-semibold text-ink-muted">{t("visit.followUp")}</h5>
              <p className="numeric mt-1 text-sm text-ink">
                {new Date(visit.followUpDate).toLocaleDateString(intlLocale(locale))}
              </p>
            </div>
          )}

          <Revisions revisions={visit.revisions} />
          <Attachments attachments={visit.attachments} onDownload={onDownload} />
        </>
      ) : null}
    </section>
  );
}

/**
 * One clinical section.
 *
 * Renders the heading even when the value is null, with words saying so. See the note on the
 * component above: a silently absent heading and a genuinely empty section look identical, and only
 * one of them is true.
 */
function Field({
  label,
  value,
  emptyLabel,
}: {
  label: string;
  value: string | null;
  emptyLabel: string;
}) {
  return (
    <div>
      <h5 className="text-xs font-semibold text-ink-muted">{label}</h5>
      {value === null || value.trim() === "" ? (
        <p className="mt-1 text-sm text-ink-subtle">{emptyLabel}</p>
      ) : (
        // `whitespace-pre-wrap`: notes are typed with line breaks during a consultation, and
        // collapsing them turns a structured examination into a paragraph.
        <p className="mt-1 whitespace-pre-wrap text-sm text-ink">{value}</p>
      )}
    </div>
  );
}

/**
 * Corrections made to this visit after it was finished — Q2, ruled 2026-09-05.
 *
 * *"A doctor reading a past visit needs to know whether the diagnosis was corrected afterwards and
 * why — that's clinical context, not an audit curiosity."*
 *
 * **Rendered only when there is something to render.** Nothing writes `visit_revisions` until the
 * amendment flow exists, so this is empty for every visit today — and an always-present heading
 * reading "no corrections" would assert that the record was checked and found unamended, which is
 * a stronger claim than "this feature is not built yet".
 */
function Revisions({ revisions }: { revisions: VisitRevision[] }) {
  const { t, locale } = useLocale();
  if (revisions.length === 0) return null;

  return (
    <div className="border-t border-border pt-3">
      <h5 className="text-xs font-semibold text-ink-muted">{t("visit.revisions")}</h5>
      <ul className="mt-2 flex flex-col gap-2">
        {revisions.map((revision) => (
          <li key={revision.id} className="rounded border border-border p-2 text-sm">
            <div className="numeric text-xs text-ink-subtle">
              {new Date(revision.createdAt).toLocaleDateString(intlLocale(locale))}
            </div>
            {/* The reason is required by the schema, so it is always present and always the most
                useful line: it says why the record changed, which the diff alone does not. */}
            <p className="text-ink">{revision.reason}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The files filed against this visit — Q11.
 *
 * Each row is a button rather than a link, because there is no URL to link to: the bytes come from
 * a bearer-authenticated endpoint and a plain `<a href>` would send no token. That is the visible
 * consequence of "never a public URL", and it is deliberate rather than awkward.
 *
 * Archived attachments are listed and marked, not hidden. Archiving is not deletion, and a doctor
 * looking for a scan they archived by mistake has to be able to find it.
 */
function Attachments({
  attachments,
  onDownload,
}: {
  attachments: VisitAttachment[];
  onDownload: (attachment: VisitAttachment) => Promise<void>;
}) {
  const { t } = useLocale();

  return (
    <div className="border-t border-border pt-3">
      <h5 className="text-xs font-semibold text-ink-muted">{t("visit.attachments")}</h5>
      {attachments.length === 0 ? (
        <p className="mt-1 text-sm text-ink-subtle">{t("visit.attachments.none")}</p>
      ) : (
        <ul className="mt-2 flex flex-col gap-2">
          {attachments.map((attachment) => (
            <li
              key={attachment.id}
              className="flex items-center justify-between gap-3 rounded border border-border p-2"
            >
              <div className="flex min-w-0 flex-col">
                {/* `break-all` rather than truncate: an Arabic filename truncated in the middle is
                    unidentifiable, and these are how a doctor tells two scans apart. */}
                <span className="break-all text-sm text-ink">{attachment.fileName}</span>
                <span className="numeric text-xs text-ink-subtle">
                  {formatBytes(attachment.sizeBytes)}
                  {attachment.archivedAt !== null && (
                    <span className="ms-2 text-warning">{t("visit.attachments.archived")}</span>
                  )}
                </span>
              </div>
              <Button size="sm" variant="secondary" onClick={() => void onDownload(attachment)}>
                {t("visit.attachments.download")}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Rounded to one decimal above a megabyte. Enough for a doctor to tell a scan from a note. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
