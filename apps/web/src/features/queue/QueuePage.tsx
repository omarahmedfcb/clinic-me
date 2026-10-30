import { Button } from "../../design-system/Button.tsx";
import { Card, EmptyState, StatusBadge } from "../../design-system/display.tsx";
import { Spinner } from "../../design-system/Spinner.tsx";
import { useLocale } from "../../i18n/locale-context.tsx";
import { BookAppointmentDialog } from "../booking/BookAppointmentDialog.tsx";
import { AppointmentDetailPanel } from "../appointment-detail/AppointmentDetailPanel.tsx";
import { mayOpenVisit, openVisit } from "../visits/open-visit.ts";
import {
  RequestTransferDialog,
  TransferBadge,
  TransferDecisionList,
} from "../transfers/TransferPanel.tsx";
import { moveQueue, type QueueEntry, type QueueMove } from "./queue-api.ts";
import { clockOf, MOVE_LABEL, nextMove } from "./queue-moves.ts";
import { CoverageBadge, VisitStatusBadge } from "./QueueBadges.tsx";
import { NoShowCard } from "./NoShowCard.tsx";
import { TransferRejections } from "./TransferRejections.tsx";
import { useQueue } from "./use-queue.ts";

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

export function QueuePage() {
  const { t, locale } = useLocale();
  const {
    authFetch, me, push, entries, candidates, doctors, failed, busyId, setBusyId, openId, setOpenId,
    booking, setBooking, bookingBusy, transferFor, setTransferFor, transferBusy, rejections,
    setRejections, now, refresh, myDoctorId, pendingByAppointment, pending, book, submitTransfer,
    decide, doctorName, refusalMessage, canCompleteVisit, canQueueActions, canPauseResume,
    canTransfer, canWriteVisits, canBook,
  } = useQueue();

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
      <TransferRejections rejections={rejections} setRejections={setRejections} />

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
      <NoShowCard candidates={candidates} rows={rows} busyId={busyId} act={act} />

      <AppointmentDetailPanel
        appointmentId={openId}
        onClose={() => setOpenId(null)}
        onChanged={() => void refresh()}
      />
    </div>
  );
}
