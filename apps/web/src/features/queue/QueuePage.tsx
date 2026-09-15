import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "../../design-system/Button.tsx";
import { Card, EmptyState, StatusBadge } from "../../design-system/display.tsx";
import { Spinner } from "../../design-system/Spinner.tsx";
import { useToast } from "../../design-system/Toast.tsx";
import type { AppointmentStatus } from "../../domain/appointment-status.ts";
import { intlLocale } from "../../i18n/format.ts";
import { useLocale } from "../../i18n/locale-context.tsx";
import type { Locale } from "../../i18n/locale.ts";
import { interpolate } from "../../i18n/interpolate.tsx";
import { BookAppointmentDialog } from "../booking/BookAppointmentDialog.tsx";
import { bookAppointment, type PatientMatch, type Slot } from "../booking/booking-api.ts";
import type { TranslationKey } from "../../i18n/strings.ts";
import { QUEUE_POLL_MS } from "../../lib/polling.ts";
import { AppointmentDetailPanel } from "../appointment-detail/AppointmentDetailPanel.tsx";
import { mayOpenVisit, openVisit } from "../visits/open-visit.ts";
import { useSession } from "../auth/session.tsx";
import { loadDoctors, type DoctorSummary } from "../schedules/schedules-api.ts";
import { isDoctorRole, ownDoctorId } from "../auth/own-doctor.ts";
import {
  RequestTransferDialog,
  TransferBadge,
  TransferDecisionList,
} from "../transfers/TransferPanel.tsx";
import {
  decideTransfer,
  loadTransfers,
  requestTransfer,
  type Transfer,
} from "../transfers/transfers-api.ts";
import {
  loadNoShowCandidates,
  loadQueue,
  moveQueue,
  type NoShowCandidate,
  type QueueCoverage,
  type QueueEntry,
  type QueueMove,
  type QueueRefusal,
} from "./queue-api.ts";

/**
 * Reception's queue — `PHASE-3.md` checkpoint 5.
 *
 * The screen a receptionist has open all day, so the gate is a real one reaching competence in
 * under ten minutes. Everything here is shaped by that: one row per patient, one obvious next
 * action on each, and no vocabulary from the state machine on screen.
 *
 * ## Polling (Q1)
 *
 * Five seconds while the tab is visible, **stopped entirely when it is hidden**, and one immediate
 * refetch on becoming visible again. The interval lives in `lib/polling.ts` beside the
 * notification one so the difference between five and fifteen seconds reads as a decision.
 *
 * ## Refresh after every mutation (Q2)
 *
 * Every action refetches on completion — success or refusal. That bounds a stale window by one
 * request instead of by one poll interval, which is what makes two receptionists converge instead
 * of drifting until the next tick.
 *
 * ## The status sent is the one on screen
 *
 * `expectedStatus` is read from the row this render is showing, never recomputed at click time.
 * Sending a freshly-fetched status would defeat the compare-and-set entirely: the check exists to
 * notice that *the screen* was out of date.
 */

const MOVE_LABEL: Record<QueueMove, TranslationKey> = {
  "check-in": "queue.action.checkIn",
  start: "queue.action.start",
  pause: "queue.action.pause",
  resume: "queue.action.resume",
  complete: "queue.action.complete",
  "no-show": "queue.action.noShow",
};

/**
 * The one obvious next action for a row, or none.
 *
 * **Takes the role, because one of these moves is not reception's.** `PHASE-3.md` Q13, revisited
 * 2026-09-03: `IN_CONSULTATION → COMPLETED` is `appointments.completeVisit`, which is `DOCTOR` only.
 * Completing a visit asserts the doctor finished and recorded their notes, and under `PHASE-4.md`
 * Q6 it finalises the record — after it, adding a forgotten sentence costs a `visit_revisions` row
 * with a reason. A receptionist tidying the board must not be able to do that to a doctor
 * mid-sentence.
 *
 * **This is not the access control.** `@RequirePermission("appointments.completeVisit")` on the
 * route is, and it refuses whatever this function returns. Hiding a button the server would reject
 * is a courtesy to the user, and Q20 is emphatic that a UI change which *looks* like a permission
 * fix is worse than none — so the server-side half landed in the same change, and a test asserts
 * the refusal rather than the absence of a button.
 *
 * Reception keeps check-in, start and no-show, so a row mid-consultation simply offers them nothing
 * — which is honest: the next move genuinely belongs to somebody else.
 */
function nextMove(
  status: AppointmentStatus,
  canComplete: boolean,
  canQueueActions: boolean,
  canPauseResume: boolean,
): QueueMove | null {
  switch (status) {
    case "BOOKED":
    case "CONFIRMED":
      return canQueueActions ? "check-in" : null;
    case "ARRIVED":
    case "WAITING":
      // Q40: starting a consultation is the appointment's doctor's, not the desk's. Reception is
      // offered nothing here, which is honest — the next move belongs to somebody else, and the
      // API refuses them either way.
      return canPauseResume ? "start" : null;
    case "IN_CONSULTATION":
      return canComplete ? "complete" : null;
    // Q34: resuming is the doctor's own act, gated on `visits.write`, so reception is offered
    // nothing here — the API refuses them either way, and this stops the board offering it.
    case "PAUSED":
      return canPauseResume ? "resume" : null;
    default:
      return null;
  }
}

function today(): string {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}

function clockOf(iso: string, locale: Locale): string {
  return new Date(iso).toLocaleTimeString(intlLocale(locale), {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

/**
 * Insurance at the desk. `PHASE-3.md` Q18.
 *
 * Minimal by ruling: the insurer's name and whether the patient is covered. **Not** the policy
 * number and not the validity dates — those live on the profile. This exists to answer one
 * question, "do I ask this person for money", at the moment it is asked.
 *
 * ## Three states, and they must not look alike
 *
 * `LAPSED` is rendered in the warning colour and **names the insurer**, because "your cover with
 * MedRight ended" is a conversation reception can actually have. `NONE` is muted and names nobody,
 * because there is nothing to discuss — the patient pays. Collapsing the two into one grey
 * "not covered" chip would be the same defect as a boolean on the wire: it deletes the distinction
 * at the exact moment it is useful.
 *
 * `COVERED` is deliberately the quietest of the three despite being the good news. It is the
 * ordinary case, and a board where every second row shouts in green trains people to stop reading
 * the rows that do not.
 */
/**
 * Q14, and the status is all of it: never a complaint, a preview or a character count.
 *
 * Absent renders nothing, for the reason `CoverageBadge` below spells out at length — a frontend
 * deployed ahead of its API is an ordinary state during a rollout, and reception's all-day screen
 * must not stop because one badge is missing.
 */
function VisitStatusBadge({ visitStatus }: { visitStatus: "DRAFT" | "COMPLETED" | null | undefined }) {
  const { t } = useLocale();
  if (visitStatus === undefined || visitStatus === null) return null;
  return (
    <span
      data-testid="visit-status-badge"
      data-visit-status={visitStatus}
      className={
        visitStatus === "DRAFT"
          ? "rounded-full bg-primary-soft px-2 py-0.5 text-xs text-primary"
          : "rounded-full bg-surface-sunken px-2 py-0.5 text-xs text-ink-muted"
      }
    >
      {t(visitStatus === "DRAFT" ? "queue.visit.inProgress" : "queue.visit.done")}
    </span>
  );
}

function CoverageBadge({ coverage }: { coverage: QueueCoverage | undefined }) {
  const { t } = useLocale();

  /**
   * `QueueEntry.coverage` is not optional in the type, and the API does send it. **A type is a claim
   * about a payload, not a validation of one** — TypeScript describes what the server promises and
   * cannot check what actually arrives.
   *
   * This crashed on 2026-09-02 for exactly that reason: the built frontend carried this badge while
   * the running API was an hour older and had no `coverage` field at all, so `coverage.standing`
   * threw and took the whole board down with it. Reception's all-day screen must not stop because
   * one badge is missing, and a frontend deployed ahead of its API is an ordinary state during a
   * rollout rather than an impossible one.
   *
   * Rendering nothing is the right degradation: an absent badge is invisible, and inventing "no
   * insurance" would be a confident lie about whether to ask someone for money.
   */
  if (coverage === undefined) return null;

  if (coverage.standing === "NONE") {
    return (
      <span className="rounded-full bg-surface-sunken px-2 py-0.5 text-xs text-ink-muted">
        {t("queue.cover.none")}
      </span>
    );
  }

  const lapsed = coverage.standing === "LAPSED";
  return (
    <span
      className={
        lapsed
          ? "inline-flex items-center gap-1 rounded-full bg-warning-soft px-2 py-0.5 text-xs text-warning"
          : "inline-flex items-center gap-1 rounded-full bg-success-soft px-2 py-0.5 text-xs text-success"
      }
      // The insurer's name is user-supplied free text and may be Latin inside an Arabic page, so it
      // is isolated: without <bdi> a name ending in punctuation reorders the label around it.
      title={coverage.insurerName}
    >
      <bdi>{coverage.insurerName}</bdi>
      {" · "}
      {t(lapsed ? "queue.cover.lapsed" : "queue.cover.covered")}
    </span>
  );
}

export function QueuePage() {
  const { t, locale } = useLocale();
  const { authFetch, me } = useSession();
  const { push } = useToast();

  const [entries, setEntries] = useState<QueueEntry[] | null>(null);
  const [candidates, setCandidates] = useState<NoShowCandidate[]>([]);
  const [doctors, setDoctors] = useState<DoctorSummary[]>([]);
  const [failed, setFailed] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  /** Which row's detail panel is open. Null closes it. */
  const [openId, setOpenId] = useState<string | null>(null);

  /** The booking dialog. Reception's most-used action, and it had no screen until now. */
  const [booking, setBooking] = useState(false);
  const [bookingBusy, setBookingBusy] = useState(false);

  const [transfers, setTransfers] = useState<Transfer[]>([]);
  /** Which queue row is having a transfer raised against it. Null closes the dialog. */
  const [transferFor, setTransferFor] = useState<QueueEntry | null>(null);
  const [transferBusy, setTransferBusy] = useState<string | null>(null);
  /**
   * Rejections seen since this screen loaded, kept until dismissed.
   *
   * The founder's requirement: **a rejection must reach reception visibly, not just change a status
   * somewhere.** A toast would not do it -- reception may be away from the desk when the doctor
   * answers, and a toast that nobody was looking at is the "silently reverts" failure with extra
   * steps. This is a banner that stays until somebody acknowledges it.
   */
  const [rejections, setRejections] = useState<Transfer[]>([]);

  /**
   * Re-read on every poll rather than held still, so "waiting 12 minutes" is honest. There is no
   * timeout by ruling -- reception can walk over -- which only works if the elapsed time is real.
   */
  const [now, setNow] = useState(() => new Date());

  const date = today();

  // Kept in a ref so the poll effect does not restart every time a refresh lands. Restarting the
  // interval on each tick would make the real period drift with response time.
  const refreshRef = useRef<() => Promise<void>>(async () => {});

  /**
   * **Whether this screen may ASK for the transfer list — not whether it may show it.**
   *
   * Read before `refresh` rather than beside the other capability checks below, because it decides
   * a fetch rather than a render, and the two fail differently. The others hide a control; a
   * missing check here took the whole board down.
   *
   * What happened: `patients.transfer` left OWNER on 2026-09-06 and `GET /transfers` moved to
   * `patients.transfer.read`, while this `Promise.all` kept asking for it unconditionally. One 403
   * rejects the whole `Promise.all`, so an owner opening the queue saw "تعذّر تحميل الطابور" and no
   * board at all — even though `/queue/today` and `/no-shows/pending` had both answered 200.
   * Measured in the browser against a throwaway database, not inferred: requests 6 and 7 returned
   * 200 and request 8, `GET /transfers?openOnly=false`, returned 403.
   *
   * A screen must not request what the matrix says the caller cannot read. It is the same rule as
   * "never offer an action the API will refuse", applied to the read side — and the read side is
   * the one that fails loudly instead of merely looking wrong.
   */
  const canReadTransfers = me.permissions["patients.transfer.read"] !== "none";

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const [queue, pending, allTransfers] = await Promise.all([
        loadQueue(authFetch, date),
        loadNoShowCandidates(authFetch, date),
        // Not openOnly: a rejection has to be seen, and an "open requests" list is exactly where a
        // rejected one stops appearing.
        //
        // An empty list for a caller who may not read transfers, rather than a request that 403s.
        // Everything downstream of it is already gated on `canTransfer`, so nothing renders from it
        // either way — this is about not making the call at all.
        canReadTransfers ? loadTransfers(authFetch, false) : Promise.resolve<Transfer[]>([]),
      ]);
      setEntries(queue.entries);
      setCandidates(pending);
      setTransfers(allTransfers);
      setNow(new Date());

      setRejections((current) => {
        const seen = new Set(current.map((item) => item.id));
        const fresh = allTransfers.filter((item) => item.status === "REJECTED" && !seen.has(item.id));
        return fresh.length === 0 ? current : [...current, ...fresh];
      });
      setFailed(false);
    } catch (err) {
      // Logged, not swallowed. The bare `catch {}` this replaced turned a wrong API path into a
      // silent "failed to load" panel with nothing in the console, and finding the cause took an
      // hour of bisecting network requests. Same principle as the render-error boundary: a failure
      // the user can see must leave something the next person can read.
      console.error("[queue-refresh]", err);
      setFailed(true);
    }
  }, [authFetch, date, canReadTransfers]);

  refreshRef.current = refresh;

  const myDoctorId = isDoctorRole(me) ? ownDoctorId(me, doctors) : null;

  /**
   * Read from the permission summary rather than from `role === "DOCTOR"`.
   *
   * A role check here would be a second copy of the §8 matrix kept by hand in the frontend, which
   * `navigation.ts` already refuses to do for the sidebar and for the same reason: it drifts the
   * first time the matrix changes and nothing notices. Naming the capability means this follows the
   * matrix wherever it goes — including if a clinic later grants it to an owner who also practises.
   *
   * A display hint, never the control. The route's `@RequirePermission` is what refuses.
   */
  const canCompleteVisit = me.permissions["appointments.completeVisit"] !== "none";

  /**
   * **The owner's queue is read-only from 2026-09-06.**
   *
   * `appointments.queueActions` became NONE for OWNER by ruling: an owner checking a patient in
   * under the owner role records "the owner did this", which in a multi-doctor clinic makes
   * accountability ambiguous. An owner who works the desk is meant to hold a second membership as
   * RECEPTIONIST and switch to it.
   *
   * The board itself stays visible — that is `appointments.write`, which the owner keeps, and
   * "read-only" is the ruling rather than "hidden". A display hint, never the control: the routes'
   * `@RequirePermission` is what refuses, and the integration suite asserts the refusal rather than
   * the absence of a button.
   */
  const canQueueActions = me.permissions["appointments.queueActions"] !== "none";
  // Q34: pausing and resuming are the doctor's, gated on `visits.write`. Reception is offered
  // nothing on a paused row, which is honest — the next move genuinely belongs to somebody else.
  const canPauseResume = me.permissions["visits.write"] !== "none";

  /**
   * **Transfers left the owner on 2026-09-06, and this screen had to follow.**
   *
   * `patients.transfer` is NONE for OWNER: a transfer is a clinical hand-off between doctors, not a
   * scheduling act. The owner still reaches this board — the queue is read-only for them rather
   * than hidden — so without this check they would see a "transfer" button on every row and an
   * accept/reject list, all of which now answer 403.
   *
   * That mismatch was **created by the matrix change and found by looking for it**, not reported: it
   * is exactly the shape `PHASE-3.md` Q20 warns about, where the screen and the API agree until one
   * of them moves. A display hint, never the control — the routes refuse regardless, and the
   * integration suite asserts the refusal rather than the absence of a button.
   */
  const canTransfer = me.permissions["patients.transfer"] !== "none";

  /** Who may write a visit, and therefore who the record screen is for. DOCTOR only. */
  const canWriteVisits = me.permissions["visits.write"] !== "none";

  /**
   * Booking is a desk act, and `appointments.write` stopped being the owner's on 2026-09-06 when it
   * was split from `appointments.read`. The board itself is `appointments.read`, which the owner
   * keeps — so without this the owner would reach the queue and be offered a "new appointment"
   * button that answers 403.
   */
  const canBook = me.permissions["appointments.write"] !== "none";

  /** Open requests, keyed by the appointment they hang off, for the badge on that row. */
  const pendingByAppointment = new Map<string, Transfer>();
  for (const transfer of transfers) {
    if (transfer.status === "PENDING") pendingByAppointment.set(transfer.appointmentId, transfer);
  }
  const pending = transfers.filter((transfer) => transfer.status === "PENDING");

  const book = useCallback(
    async (slot: Slot, patient: PatientMatch): Promise<void> => {
      setBookingBusy(true);
      try {
        const result = await bookAppointment(authFetch, {
          slotToken: slot.token,
          patientId: patient.id,
        });
        push(result.ok ? "success" : "error", result.ok ? t("booking.booked") : result.refusal.message);
        if (result.ok) setBooking(false);
      } finally {
        setBookingBusy(false);
        await refresh();
      }
    },
    [authFetch, push, refresh, t],
  );

  const submitTransfer = useCallback(
    async (entry: QueueEntry, toDoctorId: string, reason: string): Promise<void> => {
      setTransferBusy(entry.appointmentId);
      try {
        const result = await requestTransfer(authFetch, {
          appointmentId: entry.appointmentId,
          toDoctorId,
          reason,
        });
        // A refusal is a sentence the server wrote, not a status code translated here -- one place
        // decides what a refusal means and it is the service.
        push(result.ok ? "success" : "error", result.ok ? t("transfer.sent") : result.refusal.message);
        if (result.ok) setTransferFor(null);
      } finally {
        setTransferBusy(null);
        await refresh();
      }
    },
    [authFetch, push, refresh, t],
  );

  const decide = useCallback(
    async (transfer: Transfer, decision: "accept" | "reject", note: string): Promise<void> => {
      setTransferBusy(transfer.id);
      try {
        const result = await decideTransfer(authFetch, transfer.id, decision, note);
        push(
          result.ok ? "success" : "error",
          result.ok ? t(decision === "accept" ? "transfer.accepted" : "transfer.rejected") : result.refusal.message,
        );
      } finally {
        setTransferBusy(null);
        await refresh();
      }
    },
    [authFetch, push, refresh, t],
  );


  useEffect(() => {
    void loadDoctors(authFetch)
      .then(setDoctors)
      .catch(() => setDoctors([]));
  }, [authFetch]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /**
   * The poll, and the reason it is not a bare `setInterval`.
   *
   * A backgrounded tab left overnight would poll 5,760 times to learn nothing, so the timer is
   * cleared on hide rather than left running against a hidden document. Becoming visible refetches
   * immediately — a receptionist returning to the tab must not look at a fifteen-second-old queue
   * while waiting for the next tick.
   */
  useEffect(() => {
    let timer: number | undefined;

    const start = (): void => {
      if (timer !== undefined) return;
      timer = window.setInterval(() => void refreshRef.current(), QUEUE_POLL_MS);
    };

    const stop = (): void => {
      if (timer === undefined) return;
      window.clearInterval(timer);
      timer = undefined;
    };

    const onVisibility = (): void => {
      if (document.visibilityState === "visible") {
        void refreshRef.current();
        start();
      } else {
        stop();
      }
    };

    if (document.visibilityState === "visible") start();
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  const doctorName = useCallback(
    (doctorId: string): string => {
      const doctor = doctors.find((d) => d.id === doctorId);
      return doctor === undefined ? t("queue.noDoctor") : `${doctor.title} ${doctor.fullName}`.trim();
    },
    [doctors, t],
  );

  /** Turns a refusal into the sentence a receptionist reads. Never a status code. */
  const refusalMessage = useCallback(
    (refusal: QueueRefusal, entry: QueueEntry): string => {
      if (refusal.kind === "gone") return t("queue.refusal.gone");
      if (refusal.kind === "error") return t("queue.refusal.error");

      const status = refusal.currentStatus;
      if (status === undefined) {
        return refusal.kind === "moved-on"
          ? t("queue.refusal.movedOn.plain")
          : t("queue.refusal.refusedPlain");
      }

      const sentence = t(`queue.moved.${status}` as TranslationKey).replace(
        "{doctor}",
        doctorName(entry.doctorId),
      );
      return `${sentence} — ${t("queue.refusal.suffix")}`;
    },
    [doctorName, t],
  );

  async function act(entry: QueueEntry, move: QueueMove): Promise<void> {
    if (busyId !== null) return;
    setBusyId(entry.appointmentId);
    try {
      // The status this render is showing — the whole point of the compare-and-set.
      const outcome = await moveQueue(authFetch, entry.appointmentId, move, entry.status);
      if (!outcome.ok) {
        push("error", refusalMessage(outcome.refusal, entry));
        return;
      }
      // Starting a consultation IS opening the record — a doctor who pressed "start" has begun the
      // visit, and making them then find the way in was the gap that shipped with the screen.
      // Only for the doctor: reception may start a consultation and has nothing to write.
      if (move === "start" && canWriteVisits) openVisit(entry.appointmentId);
    } finally {
      setBusyId(null);
      // Refreshed on refusal as well as on success: a refusal means the screen was wrong, which is
      // precisely when it most needs replacing.
      await refresh();
    }
  }

  if (entries === null && !failed) {
    return (
      <div className="flex min-h-64 items-center justify-center">
        <Spinner size="lg" />
      </div>
    );
  }

  if (failed && entries === null) {
    return (
      <EmptyState
        title={t("queue.loadFailed")}
        message={t("queue.subtitle")}
        action={<Button onClick={() => void refresh()}>{t("queue.retry")}</Button>}
      />
    );
  }

  const rows = entries ?? [];
  const byDoctor = new Map<string, QueueEntry[]>();
  for (const entry of rows) {
    byDoctor.set(entry.doctorId, [...(byDoctor.get(entry.doctorId) ?? []), entry]);
  }

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-ink">{t("queue.title")}</h1>
          <p className="text-sm text-ink-muted">{t("queue.subtitle")}</p>
        </div>
        {canBook && <Button onClick={() => setBooking(true)}>{t("booking.action")}</Button>}
      </header>

      {booking && (
        <BookAppointmentDialog
          open
          onOpenChange={(next) => {
            if (!next) setBooking(false);
          }}
          doctors={doctors}
          pinnedDoctorId={myDoctorId}
          busy={bookingBusy}
          authFetch={authFetch}
          onBook={(slot, patient) => void book(slot, patient)}
        />
      )}

      {/*
       * A rejection has to REACH reception, not merely change a status. A toast would not do it --
       * reception may be away from the desk when the doctor answers, and a toast nobody saw is the
       * "silently reverts" failure with extra steps. This stays until acknowledged.
       */}
      {rejections.map((rejected) => (
        <div
          key={rejected.id}
          role="alert"
          className="flex flex-wrap items-center gap-3 rounded-xl border border-danger bg-danger-soft px-4 py-3 text-sm text-danger"
        >
          <span className="flex-1">
            {/*
              Three substituted values, two of them Arabic names, inside a sentence that is English
              when the interface is. Built with interpolate() so each one is isolated -- with
              .replace() the names appeared to swap places and the banner accused the wrong doctor.
            */}
            {interpolate(t("transfer.rejectedBanner"), {
              patient: rejected.patientName,
              doctor: rejected.toDoctorName,
              reason: rejected.decisionNote ?? "—",
            })}
          </span>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => setRejections((current) => current.filter((item) => item.id !== rejected.id))}
          >
            {t("transfer.rejectedBanner.dismiss")}
          </Button>
        </div>
      ))}

      {/* Reception sees every open request, each doctor sees their own — and an owner sees none,
          because deciding a hand-off is not theirs since 2026-09-06. */}
      {canTransfer && (
      <TransferDecisionList
        transfers={pending}
        ownDoctorId={myDoctorId}
        now={now}
        busyId={transferBusy}
        onDecide={(transfer, decision, note) => void decide(transfer, decision, note)}
      />
      )}

      {transferFor !== null && (
        <RequestTransferDialog
          open
          onOpenChange={(open) => {
            if (!open) setTransferFor(null);
          }}
          doctors={doctors}
          currentDoctorId={transferFor.doctorId}
          patientName={transferFor.patientName ?? ""}
          busy={transferBusy === transferFor.appointmentId}
          onSubmit={(toDoctorId, reason) => void submitTransfer(transferFor, toDoctorId, reason)}
        />
      )}

      {rows.length === 0 ? (
        <EmptyState title={t("queue.empty.title")} message={t("queue.empty.body")} />
      ) : (
        // Grouped by doctor, all doctors at once (Q11): reception works the room, not a doctor.
        [...byDoctor.entries()].map(([doctorId, group]) => (
          <Card key={doctorId} title={doctorName(doctorId)}>
            <ul className="flex flex-col">
              {group.map((entry) => {
                const move = nextMove(entry.status, canCompleteVisit, canQueueActions, canPauseResume);
                const busy = busyId === entry.appointmentId;
                return (
                  <li
                    key={entry.appointmentId}
                    className="flex flex-wrap items-center gap-3 border-b border-border py-3 last:border-0"
                  >
                    {/*
                      The patient's name opens the detail panel. A button rather than a click
                      handler on the row: the row also carries an action button, and a whole
                      clickable row containing another control is a target people hit by accident.
                    */}
                    <div className="min-w-48 flex-1">
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => setOpenId(entry.appointmentId)}
                          className="font-medium text-ink underline decoration-border-strong underline-offset-2 hover:decoration-ink"
                        >
                          {entry.patientName}
                        </button>
                        {entry.isWalkIn && (
                          <span className="rounded-full bg-surface-sunken px-2 py-0.5 text-xs text-ink-muted">
                            {t("queue.walkIn")}
                          </span>
                        )}
                        {/*
                          Q18: beside the name, not in an actions column. Reception reads this row
                          with the patient standing in front of them, and "do I ask for money" is
                          answered next to who the person is.
                        */}
                        <CoverageBadge coverage={entry.coverage} />
                        <VisitStatusBadge visitStatus={entry.visitStatus} />
                        {/*
                          Q16: the patient stays in the ORIGINAL doctor's queue while a request is
                          open. A badge on this row, never a second list and never a move -- exactly
                          one queue, always.
                        */}
                        {pendingByAppointment.has(entry.appointmentId) && (
                          <TransferBadge
                            transfer={pendingByAppointment.get(entry.appointmentId)!}
                            now={now}
                          />
                        )}
                      </div>
                      <div className="text-xs text-ink-muted">
                        <span className="numeric">{clockOf(entry.scheduledStart, locale)}</span>
                        {" · "}
                        {entry.waitedMs === null
                          ? t("queue.notArrived")
                          : t("queue.waitingFor").replace(
                              "{minutes}",
                              String(Math.max(0, Math.round(entry.waitedMs / 60_000))),
                            )}
                      </div>
                    </div>

                    <StatusBadge status={entry.status} />

                    <div className="flex gap-2">
                      {/* A row already mid-consultation: the doctor navigated away, or someone else
                          started it. Without this the only way back to the record is the URL. */}
                      {mayOpenVisit(me.permissions, entry.status) && entry.status === "IN_CONSULTATION" && (
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => openVisit(entry.appointmentId)}
                        >
                          {t("queue.action.openVisit")}
                        </Button>
                      )}
                      {move !== null && (
                        <Button
                          size="sm"
                          disabled={busy}
                          onClick={() => void act(entry, move)}
                        >
                          {busy ? t("queue.action.working") : t(MOVE_LABEL[move])}
                        </Button>
                      )}
                      {/* Hidden once a request is open: one open request per patient, and the
                          server refuses a second anyway. Offering a button that always fails is
                          worse than not offering it. */}
                      {canTransfer && !pendingByAppointment.has(entry.appointmentId) && (
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={transferBusy === entry.appointmentId}
                          onClick={() => setTransferFor(entry)}
                        >
                          {t("transfer.action")}
                        </Button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          </Card>
        ))
      )}

      {/*
       * The no-show list. Q8: it proposes and a human confirms — there is deliberately no
       * "mark all" here, and the warning is on screen rather than in a comment, because the
       * failure it prevents is marking a patient absent who is sitting in the waiting room.
       */}
      <Card title={t("queue.noShow.title")}>
        <p className="text-sm text-ink-muted">{t("queue.noShow.subtitle")}</p>
        {candidates.length === 0 ? (
          <p className="py-3 text-sm text-ink-subtle">{t("queue.noShow.empty")}</p>
        ) : (
          <>
            <p className="py-2 text-xs text-warning">{t("queue.noShow.warning")}</p>
            <ul className="flex flex-col">
              {candidates.map((candidate) => {
                /*
                 * The row as the queue is currently showing it, so `expectedStatus` is the real
                 * one. A candidate is BOOKED *or* CONFIRMED and `/no-shows/pending` does not say
                 * which — hardcoding either would send a wrong expectation half the time and the
                 * compare-and-set would correctly refuse an action nobody got wrong. Both statuses
                 * are on the queue, so the row is always in the list this screen already has.
                 */
                const entry = rows.find((r) => r.appointmentId === candidate.appointmentId);
                return (
                  <li
                    key={candidate.appointmentId}
                    className="flex flex-wrap items-center gap-3 border-b border-border py-3 last:border-0"
                  >
                    <div className="min-w-48 flex-1">
                      <div className="font-medium text-ink">{candidate.patientName}</div>
                      <div className="text-xs text-ink-muted">
                        {t("queue.noShow.since").replace("{time}", clockOf(candidate.eligibleSince, locale))}
                      </div>
                    </div>
                    <Button
                      size="sm"
                      variant="danger"
                      disabled={entry === undefined || busyId === candidate.appointmentId}
                      onClick={() => {
                        if (entry !== undefined) void act(entry, "no-show");
                      }}
                    >
                      {t("queue.noShow.confirm")}
                    </Button>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </Card>

      <AppointmentDetailPanel
        appointmentId={openId}
        onClose={() => setOpenId(null)}
        onChanged={() => void refresh()}
      />
    </div>
  );
}
