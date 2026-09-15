import { useCallback, useEffect, useState } from "react";
import { Button } from "../../design-system/Button.tsx";
import { mayOpenVisit, openVisit } from "../visits/open-visit.ts";
import { StatusBadge } from "../../design-system/display.tsx";
import { Drawer } from "../../design-system/overlays.tsx";
import { Spinner } from "../../design-system/Spinner.tsx";
import { useToast } from "../../design-system/Toast.tsx";
import { formatMinor, intlLocale } from "../../i18n/format.ts";
import { useLocale } from "../../i18n/locale-context.tsx";
import { useSession } from "../auth/session.tsx";
import { canCancel, canReschedule } from "../../domain/appointment-status.ts";
import { loadSlots, rescheduleAppointment, type Slot } from "../booking/booking-api.ts";
import { ErrorBoundary } from "../../design-system/ErrorBoundary.tsx";
import { ClinicalSection } from "./ClinicalSection.tsx";
import {
  cancelAppointment,
  loadDetail,
  loadSummary,
  type AppointmentDetail,
  type ClinicalSummary,
} from "./detail-api.ts";

/**
 * The appointment detail panel — `PHASE-4.md`.
 *
 * Opened from the day view and from the queue. What it shows is decided by **which requests
 * succeed**, not by a role check written here: the clinical sections come from endpoints guarded by
 * `visits.readContent`, which only a doctor holds. Reception's panel is missing the clinical
 * sections because the server refuses them, not because this component chose to hide them.
 *
 * That distinction is the point. A component that decided for itself would be one edit away from
 * showing a diagnosis to reception, and nothing about the response would have said so.
 */
interface Props {
  appointmentId: string | null;
  onClose: () => void;
  /** Called after any mutation, so the calling screen can refetch and converge. */
  onChanged: () => void;
}


export function AppointmentDetailPanel({ appointmentId, onClose, onChanged }: Props) {
  const { t, locale } = useLocale();
  const { me, authFetch } = useSession();
  const { push } = useToast();

  const [detail, setDetail] = useState<AppointmentDetail | null>(null);
  const [summary, setSummary] = useState<ClinicalSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState("");

  /**
   * Rescheduling. Previously this section carried only a note explaining how it *would* work —
   * `rescheduleAppointment` and the availability call existed in the client and nothing called
   * them, so the endpoint §8 grants reception was unreachable from any screen.
   */
  const [moving, setMoving] = useState(false);
  const [moveDate, setMoveDate] = useState("");
  const [moveSlots, setMoveSlots] = useState<Slot[] | null>(null);
  const [movingBusy, setMovingBusy] = useState(false);

  const onReschedule = useCallback(
    async (slot: Slot): Promise<void> => {
      if (appointmentId === null) return;
      setMovingBusy(true);
      try {
        const result = await rescheduleAppointment(authFetch, appointmentId, slot.token);
        push(result.ok ? "success" : "error", result.ok ? t("booking.rescheduled") : result.refusal.message);
        if (result.ok) {
          setMoving(false);
          setMoveSlots(null);
          onChanged();
        }
      } finally {
        setMovingBusy(false);
      }
    },
    [appointmentId, authFetch, onChanged, push, t],
  );

  const refresh = useCallback(async (): Promise<void> => {
    if (appointmentId === null) return;
    setLoading(true);
    try {
      const next = await loadDetail(authFetch, appointmentId);
      setDetail(next);
      // A 403 here is reception's expected answer, and returns null rather than throwing.
      setSummary(await loadSummary(authFetch, appointmentId));
    } catch {
      push("error", t("detail.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [appointmentId, authFetch, push, t]);

  useEffect(() => {
    if (appointmentId === null) {
      setDetail(null);
      setSummary(null);
      setReason("");
      return;
    }
    void refresh();
  }, [appointmentId, refresh]);

  async function onCancel(): Promise<void> {
    if (detail === null || reason.trim().length === 0) return;
    setCancelling(true);
    try {
      const result = await cancelAppointment(authFetch, detail.appointmentId, reason.trim());
      if (result.ok) {
        push("success", t("detail.cancelled"));
        onChanged();
        onClose();
      } else {
        push("error", t("detail.cancelFailed"));
      }
    } finally {
      setCancelling(false);
    }
  }

  /**
   * **Was `(minor / 100).toFixed(2)`, with no currency at all** — found by the money sweep of
   * 2026-09-05 rather than reported, because nothing about it looks wrong on an Egyptian screen.
   *
   * Two faults in one line. It hardcoded the exponent, which is the mistake `formatMinor` exists to
   * prevent: KWD, BHD and JOD have three decimal places and JPY has none, so this rendered a
   * Kuwaiti amount ten times too large. And it emitted a bare number, so a receptionist reading
   * "300.00" had nothing telling them which currency — on the one screen where the number is what a
   * patient is about to be asked to pay.
   */
  const canWrite = me.permissions["appointments.write"] !== "none";

  const money = (minor: number): string => formatMinor(minor, me.currency, locale);

  return (
    <Drawer
      open={appointmentId !== null}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={detail?.patientNameAr ?? t("detail.title")}
    >
      {loading && detail === null ? (
        <div className="flex justify-center py-10">
          <Spinner size="lg" />
        </div>
      ) : detail === null ? (
        <p className="py-6 text-sm text-ink-muted">{t("detail.loadFailed")}</p>
      ) : (
        <div className="flex flex-col gap-5">
          <section className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <StatusBadge status={detail.status} />
              <span className="numeric text-sm text-ink-muted">
                {new Date(detail.scheduledStart).toLocaleString(intlLocale(locale), {
                  dateStyle: "medium",
                  timeStyle: "short",
                })}
              </span>
            </div>
            <Row label={t("detail.service")} value={detail.serviceNameAr} />
            <Row label={t("detail.doctor")} value={detail.doctorName} />
            {detail.complaintSummary !== null && (
              <Row label={t("detail.complaint")} value={detail.complaintSummary} />
            )}
          </section>

          {/*
            Contact details and payment: reception's half. Present for a doctor too — CLAUDE.md
            puts visit metadata and payments on the reception-visible side, and nothing here is
            clinical content.
          */}
          <section className="flex flex-col gap-2 border-t border-border pt-4">
            <h4 className="text-sm font-semibold text-ink">{t("detail.contact")}</h4>
            <Row label={t("detail.phone")} value={detail.phoneE164} numeric />
            {detail.secondaryPhone !== null && (
              <Row label={t("detail.phone2")} value={detail.secondaryPhone} numeric />
            )}
            {detail.address !== null && <Row label={t("detail.address")} value={detail.address} />}
          </section>

          <section className="flex flex-col gap-2 border-t border-border pt-4">
            <h4 className="text-sm font-semibold text-ink">{t("detail.payment")}</h4>
            {detail.payment === null ? (
              // Not the same as a zero balance, and must not read as one.
              <p className="text-sm text-ink-subtle">{t("detail.payment.none")}</p>
            ) : (
              <>
                <Row label={t("detail.payment.due")} value={money(detail.payment.amountDueMinor)} numeric />
                <Row label={t("detail.payment.paid")} value={money(detail.payment.amountPaidMinor)} numeric />
              </>
            )}
          </section>

          {/* The way into the record from the panel. Doctor only, and only once the patient is
              present — the screen itself refuses otherwise, and a button that always fails is
              worse than no button. */}
          {mayOpenVisit(me.permissions, detail.status) && (
            <Button variant="secondary" fullWidth onClick={() => openVisit(detail.appointmentId)}>
              {t("queue.action.openVisit")}
            </Button>
          )}

          {/* Doctor only. Absent for reception because the server refused it, not because of a branch here. */}
          {summary !== null && (
            /* Scoped so a clinical-section fault shows there, leaving the rest of the panel usable. */
            <ErrorBoundary where="Clinical summary">
              <ClinicalSection
                appointmentId={detail.appointmentId}
                summary={summary}
                status={detail.status}
              />
            </ErrorBoundary>
          )}

          {/*
            Offered only where the state machine says the move is legal, asked rather than
            restated: `canCancel`/`canReschedule` mirror the edge table and
            `appointment-actions-conformance.spec.ts` fails if the two drift apart.

            This section used to render unconditionally, so a COMPLETED appointment was offered a
            cancel button -- rewriting a medical record after the visit happened -- and an
            IN_CONSULTATION one was offered it mid-consultation. The API refused both; the panel
            offered an action that could only ever fail. Hiding it is the *second* half of that
            fix, never the whole of it: reschedule had no server-side check at all until this
            change, and hiding its button would have left the hole open.
          */}
          {/*
            `canWrite` on top of the status test. `canCancel`/`canReschedule` answer "does the state
            machine allow this move"; they say nothing about whether *this caller* may make it. An
            owner reaches this panel through `appointments.read` and lost `appointments.write` on
            2026-09-06, so without this they would be offered cancel and reschedule and get 403 on
            both. Two different questions, and the panel needs both answered.
          */}
          {canWrite && (canCancel(detail.status) || canReschedule(detail.status)) && (
          <section className="flex flex-col gap-2 border-t border-border pt-4">
            <h4 className="text-sm font-semibold text-ink">{t("detail.actions")}</h4>
            {canCancel(detail.status) && (
            <>
            <label className="text-xs text-ink-muted" htmlFor="cancel-reason">
              {t("detail.cancelReason")}
            </label>
            <input
              id="cancel-reason"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              className="w-full rounded-lg border border-border-strong bg-surface px-3 py-2 text-sm text-start"
              placeholder={t("detail.cancelReason.placeholder")}
            />
            <div className="flex flex-wrap gap-2">
              <Button
                variant="danger"
                size="sm"
                disabled={cancelling || reason.trim().length === 0}
                onClick={() => void onCancel()}
              >
                {t("detail.cancel")}
              </Button>
            </div>
            </>
            )}
            {/*
              Reschedule and change-service are the SAME call: a slot token carries doctor,
              service, start and end together, so booking a token minted for another service is
              the service change. scheduled_start is written in exactly two places in the API,
              both from a verified token — there is no second write path, and both go through the
              no_double_booking exclusion constraint.
            */}
            {canReschedule(detail.status) && (
            <>
            <p className="text-xs text-ink-subtle">{t("detail.reschedule.note")}</p>

            {!moving ? (
              <Button size="sm" variant="secondary" onClick={() => setMoving(true)}>
                {t("booking.reschedule")}
              </Button>
            ) : (
              <div className="flex flex-col gap-2 rounded-lg border border-border p-3">
                <span className="text-sm font-medium">{t("booking.reschedule.title")}</span>
                <input
                  type="date"
                  value={moveDate}
                  onChange={(event) => {
                    const next = event.target.value;
                    setMoveDate(next);
                    setMoveSlots(null);
                    // The slot list must come from the server for THIS doctor and service: the
                    // token carries both, so a slot minted elsewhere is not a reschedule of this
                    // appointment. Passing the detail's own ids is what keeps that true.
                    void loadSlots(authFetch, detail.doctorId, detail.serviceId, next).then(setMoveSlots);
                  }}
                  className="w-full rounded-lg border border-border-strong bg-surface px-3 py-2 text-sm"
                />
                {moveSlots !== null &&
                  (moveSlots.length === 0 ? (
                    <p className="text-sm text-ink-muted">{t("booking.noSlots")}</p>
                  ) : (
                    <div className="flex flex-wrap gap-2">
                      {moveSlots.map((slot) => (
                        <Button
                          key={slot.token}
                          size="sm"
                          variant="secondary"
                          disabled={movingBusy}
                          onClick={() => void onReschedule(slot)}
                        >
                          <span className="numeric">
                            {new Date(slot.start).toLocaleTimeString(intlLocale(locale), { hour: "2-digit", minute: "2-digit" })}
                          </span>
                        </Button>
                      ))}
                    </div>
                  ))}
              </div>
            )}
            </>
            )}
          </section>
          )}
        </div>
      )}
    </Drawer>
  );
}

function Row({ label, value, numeric = false }: { label: string; value: string | null; numeric?: boolean }) {
  if (value === null) return null;
  return (
    <div className="flex justify-between gap-4 text-sm">
      <span className="text-ink-muted">{label}</span>
      <span className={numeric ? "numeric text-ink" : "text-ink"}>{value}</span>
    </div>
  );
}
