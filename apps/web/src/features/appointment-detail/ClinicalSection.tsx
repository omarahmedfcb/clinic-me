import { useEffect, useState } from "react";
import type { AppointmentStatus } from "../../domain/appointment-status.ts";
import { Button } from "../../design-system/Button.tsx";
import { intlLocale } from "../../i18n/format.ts";
import { useLocale } from "../../i18n/locale-context.tsx";
import type { TranslationKey } from "../../i18n/strings.ts";
import { useSession } from "../auth/session.tsx";
import { VisitDetailView } from "../visits/VisitDetailView.tsx";
import { loadHistory, type ClinicalHistory, type ClinicalSummary } from "./detail-api.ts";

/**
 * The doctor's clinical view — `PHASE-4.md`. Rendered only when the summary request succeeded,
 * which only happens for a doctor.
 *
 * ## Level 1 is never behind a button
 *
 * The summary renders immediately. A safety signal behind a click is one a busy doctor does not
 * see, and allergies are the case that decides it.
 *
 * ## An empty allergy list is not a negative finding
 *
 * "No known allergies" and "nobody has asked" are opposite answers and an empty list alone cannot
 * tell them apart. `allergiesReviewedAt` is what separates them, and the wording changes
 * accordingly — a blank box must not read as reassurance it has not earned.
 *
 * ## Medication is shown as derived
 *
 * Each line carries the prescription it came from and its date, because it was read out of a
 * prescription rather than entered by anyone. Presenting it as an entered fact is exactly what
 * makes a stale list dangerous.
 *
 * ## History opens — Q18, and the defect that started it
 *
 * Both lists here name a visit, and until `GET /visits/:id` existed neither could be opened: the
 * recent-visit dates and the five history blocks were bare text, so a doctor could see that a visit
 * happened and read one line of it and do nothing else. **History that cannot be opened is a list
 * of dates.** Every entry is now a button, and opening one replaces this section with the full
 * record rather than pushing a second overlay on top of the drawer.
 *
 * The `.slice(0, 5)` cap stays. It was a symptom of the same problem rather than the problem — five
 * summaries is a reasonable amount to scan when each of them opens; it was only unreasonable when
 * they were all a doctor could ever see.
 */
export function ClinicalSection({
  appointmentId,
  summary,
  status,
}: {
  appointmentId: string;
  summary: ClinicalSummary;
  /**
   * The appointment's current status, and it is a **dependency of the read below, not decoration.**
   *
   * `NOT_PRESENT` is decided by the server from this status. Without it in the dependency list the
   * refusal is fetched once when the drawer opens and then latched forever: a doctor who opens a
   * CONFIRMED appointment, presses "start consultation", and looks back at the panel is still told
   * the patient is not with them, because nothing re-asked. Found on review, 2026-09-07.
   */
  status: AppointmentStatus;
}) {
  const { t, locale } = useLocale();
  const { authFetch } = useSession();
  const [history, setHistory] = useState<ClinicalHistory | null>(null);
  const [blocked, setBlocked] = useState<"NOT_PRESENT" | null>(null);
  /**
   * Which visit is open, held as its **appointment** id — the visit read is appointment-scoped
   * (Q18 as revised), so that is the address, and a visit id would not open anything.
   */
  const [openAppointmentId, setOpenAppointmentId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const result = await loadHistory(authFetch, appointmentId);
      if (cancelled) return;
      if (result.ok) {
        setHistory(result.history);
        setBlocked(null);
      } else {
        setHistory(null);
        setBlocked(result.reason === "NOT_PRESENT" ? "NOT_PRESENT" : null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [appointmentId, authFetch, status]);

  // A visit is open: this section becomes that visit. Rendering it here rather than as a nested
  // dialog keeps one overlay on screen -- the drawer -- which is the difference between "go back"
  // meaning one thing and meaning two.
  if (openAppointmentId !== null) {
    return (
      <div className="border-t border-border pt-4">
        <VisitDetailView
          appointmentId={openAppointmentId}
          onBack={() => setOpenAppointmentId(null)}
        />
      </div>
    );
  }

  const age =
    summary.dateOfBirth === null
      ? null
      : String(Math.floor((Date.now() - Date.parse(summary.dateOfBirth)) / 31_557_600_000));

  return (
    <section className="flex flex-col gap-4 border-t border-border pt-4">
      <h4 className="text-sm font-semibold text-ink">{t("detail.clinical")}</h4>

      <div className="flex gap-4 text-sm">
        {age !== null && (
          <span className="text-ink-muted">
            {t("detail.age")} <span className="numeric text-ink">{age}</span>
          </span>
        )}
        {summary.gender !== null && (
          <span className="text-ink-muted">
            {t(`intake.gender.${summary.gender}` as TranslationKey)}
          </span>
        )}
      </div>

      {/* Allergies first, and visually loudest. It is the reason this section is not gated. */}
      <div>
        <h5 className="text-xs font-semibold text-ink-muted">{t("detail.allergies")}</h5>
        {summary.allergies.length > 0 ? (
          <ul className="mt-1 flex flex-col gap-1">
            {summary.allergies.map((allergy) => (
              <li
                key={allergy.id}
                className="rounded border border-danger bg-danger-soft px-2 py-1 text-sm text-danger"
              >
                <span className="font-medium">{allergy.substance}</span>
                {allergy.reaction !== null && <span> — {allergy.reaction}</span>}
              </li>
            ))}
          </ul>
        ) : summary.allergiesReviewedAt !== null ? (
          <p className="mt-1 text-sm text-ink">
            {t("detail.allergies.none")}{" "}
            <span className="numeric text-ink-subtle">
              {new Date(summary.allergiesReviewedAt).toLocaleDateString(intlLocale(locale))}
            </span>
          </p>
        ) : (
          // Never "no known allergies" — nobody has asked, and saying otherwise would invent a
          // negative finding that no clinician recorded.
          <p className="mt-1 text-sm text-warning">{t("detail.allergies.unknown")}</p>
        )}
      </div>

      <div>
        <h5 className="text-xs font-semibold text-ink-muted">{t("detail.medication")}</h5>
        {summary.currentMedication.length === 0 ? (
          // Correct, and it will look broken until prescriptions ship — hence explicit words
          // rather than an empty div.
          <p className="mt-1 text-sm text-ink-subtle">{t("detail.medication.none")}</p>
        ) : (
          <ul className="mt-1 flex flex-col gap-1 text-sm">
            {summary.currentMedication.map((med) => (
              <li key={`${med.sourcePrescriptionId}-${med.medicationName}`}>
                <span className="text-ink">
                  {med.medicationName} — {med.dose}, {med.frequency}
                </span>{" "}
                <span className="text-xs text-ink-subtle">
                  {t("detail.medication.from")}{" "}
                  <span className="numeric">{new Date(med.issuedAt).toLocaleDateString(intlLocale(locale))}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {summary.activeTreatmentPlans.length > 0 && (
        <div>
          <h5 className="text-xs font-semibold text-ink-muted">{t("detail.plans")}</h5>
          <ul className="mt-1 flex flex-col gap-1 text-sm text-ink">
            {summary.activeTreatmentPlans.map((plan) => (
              <li key={plan.id}>
                {plan.title}{" "}
                <span className="numeric text-ink-subtle">
                  {plan.completedSessions}/{plan.totalSessions}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div>
        <h5 className="text-xs font-semibold text-ink-muted">{t("detail.visits")}</h5>
        {summary.recentVisits.length === 0 ? (
          <p className="mt-1 text-sm text-ink-subtle">{t("detail.visits.none")}</p>
        ) : (
          <ul className="mt-1 flex flex-col gap-1 text-sm text-ink">
            {summary.recentVisits.map((visit) => (
              <li key={visit.id}>
                <button
                  type="button"
                  onClick={() => setOpenAppointmentId(visit.appointmentId)}
                  className="numeric rounded text-start underline decoration-dotted underline-offset-4 hover:text-primary"
                >
                  {new Date(visit.at).toLocaleDateString(intlLocale(locale))}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Level 2. Explained rather than hidden, so the doctor knows it exists and what opens it. */}
      <div className="border-t border-border pt-3">
        {history !== null ? (
          <div className="flex flex-col gap-2">
            <h5 className="text-xs font-semibold text-ink-muted">{t("detail.history")}</h5>
            {history.visits.length === 0 ? (
              <p className="text-sm text-ink-subtle">{t("detail.visits.none")}</p>
            ) : (
              history.visits.slice(0, 5).map((visit) => (
                // A button, not an article with a click handler: the whole block is the target, and
                // it has to be reachable by keyboard and announced as actionable. `text-start` is
                // required -- a button centres its content by default, which reads as broken in a
                // right-to-left column of clinical text.
                <button
                  key={visit.id}
                  type="button"
                  onClick={() => setOpenAppointmentId(visit.appointmentId)}
                  aria-label={`${t("visit.open")} — ${new Date(visit.completedAt ?? visit.createdAt).toLocaleDateString(intlLocale(locale))}`}
                  className="w-full rounded border border-border p-2 text-start text-sm transition-colors hover:border-border-strong hover:bg-surface-sunken"
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="numeric text-xs text-ink-subtle">
                      {new Date(visit.completedAt ?? visit.createdAt).toLocaleDateString(intlLocale(locale))}
                    </span>
                    <span className="text-xs text-primary">{t("visit.open")}</span>
                  </div>
                  {visit.diagnosis !== null && (
                    <p className="text-ink">
                      <span className="text-ink-muted">{t("detail.diagnosis")}: </span>
                      {visit.diagnosis}
                    </p>
                  )}
                  {visit.complaint !== null && <p className="text-ink-muted">{visit.complaint}</p>}
                </button>
              ))
            )}
          </div>
        ) : blocked === "NOT_PRESENT" ? (
          <p className="text-sm text-ink-muted">{t("detail.history.locked")}</p>
        ) : (
          <p className="text-sm text-ink-subtle">{t("detail.history.none")}</p>
        )}
      </div>
    </section>
  );
}

/** Kept for the panel's footer wiring; the actions live on the panel itself. */
export const ClinicalSectionActions = Button;
