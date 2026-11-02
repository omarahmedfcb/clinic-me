import { useCallback, useEffect, useRef, useState } from "react";
import { useToast } from "../../design-system/Toast.tsx";
import { useLocale } from "../../i18n/locale-context.tsx";
import type { TranslationKey } from "../../i18n/strings.ts";
import { bookAppointment, type PatientMatch, type Slot } from "../booking/booking-api.ts";
import { QUEUE_POLL_MS } from "../../lib/polling.ts";
import { useSession } from "../auth/session.tsx";
import { loadDoctors, type DoctorSummary } from "../schedules/schedules-api.ts";
import { isDoctorRole, ownDoctorId } from "../auth/own-doctor.ts";
import {
  decideTransfer,
  loadTransfers,
  requestTransfer,
  type Transfer,
} from "../transfers/transfers-api.ts";
import {
  loadNoShowCandidates,
  loadQueue,
  type NoShowCandidate,
  type QueueEntry,
  type QueueRefusal,
} from "./queue-api.ts";
import { queueCapabilities } from "./queue-capabilities.ts";
import { today } from "./queue-moves.ts";

export function useQueue() {
  const { t } = useLocale();
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
  const shownRejections = useRef(new Set<string>());

  const capabilities = queueCapabilities(me);
  const { canReadTransfers } = capabilities;

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

      // Every rejection ever shown, not those still on screen: a dismissed one must not return.
      const fresh = allTransfers.filter((item) => item.status === "REJECTED" && !shownRejections.current.has(item.id));
      for (const item of fresh) shownRejections.current.add(item.id);
      if (fresh.length > 0) setRejections((current) => [...current, ...fresh]);
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

  return {
    ...capabilities,
    authFetch,
    me,
    push,
    entries,
    candidates,
    doctors,
    failed,
    busyId,
    setBusyId,
    openId,
    setOpenId,
    booking,
    setBooking,
    bookingBusy,
    transferFor,
    setTransferFor,
    transferBusy,
    rejections,
    setRejections,
    now,
    refresh,
    myDoctorId,
    pendingByAppointment,
    pending,
    book,
    submitTransfer,
    decide,
    doctorName,
    refusalMessage,
  };
}
