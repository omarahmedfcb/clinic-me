// The follow-up (Q24) and the button that finishes the visit (Q26), plus Q27's disabled placeholder.
// Ending the visit is Q6's completion: one act, which also returns the patient to reception.

import { useState } from "react";
import { Button } from "../../design-system/Button.tsx";
import { Select, TextInput } from "../../design-system/fields.tsx";
import { useLocale } from "../../i18n/locale-context.tsx";
import { completeVisit, type CompletedVisit } from "./draft-api.ts";
import { pauseVisit, resumeVisit } from "./pause-api.ts";

type AuthFetch = (path: string, init?: RequestInit) => Promise<Response>;

type FollowUpMode = "NONE" | "INTERVAL" | "DATE";

interface Props {
  authFetch: AuthFetch;
  appointmentId: string;
  visitId: string;
  /** The revision the screen last saw confirmed. Completion is a write and compares against it. */
  revision: () => number;
  /** Flushes anything typed but not yet saved, so completion cannot race the autosave. */
  flush: () => Promise<void>;
  onCompleted: (completed: CompletedVisit) => void;
}

export function EndVisitSection({
  authFetch,
  appointmentId,
  visitId,
  revision,
  flush,
  onCompleted,
}: Props) {
  const { t } = useLocale();
  const [mode, setMode] = useState<FollowUpMode>("NONE");
  const [days, setDays] = useState("14");
  const [date, setDate] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [paused, setPaused] = useState(false);
  const [pauseReason, setPauseReason] = useState("");

  async function end(): Promise<void> {
    setBusy(true);
    setMessage(null);
    // Anything still in the autosave timer goes first: completing with unflushed text would refuse
    // on the revision, or worse, finish a visit without the last sentence.
    await flush();

    const result = await completeVisit(authFetch, appointmentId, visitId, {
      expectedRevision: revision(),
      ...(mode === "INTERVAL" ? { followUpIntervalDays: Math.max(1, Number(days) || 1) } : {}),
      ...(mode === "DATE" && date !== "" ? { followUpDate: date } : {}),
    });
    setBusy(false);

    if (!result.ok) {
      setMessage(
        result.reason === "STALE"
          ? t("visit.endStale")
          : result.reason === "ALREADY_COMPLETED"
            ? t("visit.alreadyCompleted")
            : t("visit.endFailed"),
      );
      return;
    }

    setDone(true);
    const { followUpDate, followUpAppointmentId } = result.completed;
    setMessage(
      followUpDate === null
        ? t("visit.ended")
        : followUpAppointmentId === null
          ? // Never silent: a follow-up nobody knows is missing is worse than none at all.
            t("followUp.notBooked").replace("{at}", followUpDate)
          : t("followUp.booked").replace("{at}", followUpDate),
    );
    onCompleted(result.completed);
  }

  /**
   * Pause and resume — Q34. The draft is untouched: it stays open, stays private to its author, and
   * PAUSED counts as present for this doctor, so nothing about the record closes underneath them.
   */
  async function togglePause(): Promise<void> {
    setBusy(true);
    setMessage(null);
    const moved = paused
      ? await resumeVisit(authFetch, appointmentId)
      : await pauseVisit(authFetch, appointmentId, pauseReason.trim());
    setBusy(false);
    if (!moved) {
      setMessage(t("visit.pauseFailed"));
      return;
    }
    setPaused(!paused);
    setMessage(paused ? null : t("visit.paused"));
  }

  return (
    <section className="mt-4 grid gap-3 rounded-lg border border-border p-3">
      <h2 className="text-sm font-semibold text-ink">{t("followUp.title")}</h2>

      <div className="grid gap-2 sm:grid-cols-2 sm:items-end">
        <Select
          label={t("followUp.title")}
          value={mode}
          options={[
            { value: "NONE", label: t("followUp.none") },
            { value: "INTERVAL", label: t("followUp.interval") },
            { value: "DATE", label: t("followUp.date") },
          ]}
          onChange={(event) => setMode(event.target.value as FollowUpMode)}
        />
        {mode === "INTERVAL" && (
          <TextInput
            label={t("followUp.days")}
            numeric
            value={days}
            onChange={(event) => setDays(event.target.value)}
          />
        )}
        {mode === "DATE" && (
          <TextInput
            label={t("followUp.date")}
            type="date"
            value={date}
            onChange={(event) => setDate(event.target.value)}
          />
        )}
      </div>

      {/* Q34. The reason lands on the `appointment_events` row, never on the queue: it is written by
          a clinician, and Q14's line puts anything clinician-authored off reception's board. */}
      {!paused && (
        <TextInput
          label={t("visit.pauseReason")}
          value={pauseReason}
          onChange={(event) => setPauseReason(event.target.value)}
        />
      )}

      <div className="flex flex-wrap items-center gap-3">
        <Button data-testid="end-visit" loading={busy} disabled={done} onClick={() => void end()}>
          {t("visit.end")}
        </Button>

        <Button
          data-testid={paused ? "resume-visit" : "pause-visit"}
          variant="secondary"
          disabled={done}
          onClick={() => void togglePause()}
        >
          {t(paused ? "visit.resume" : "visit.pause")}
        </Button>

        {/* Q27, a deliberate exception to the no-dead-buttons rule: a visible gap is information,
            where a missing one is indistinguishable from a bug. Disabled, and no handler. */}
        <Button
          data-testid="stock-button"
          variant="secondary"
          disabled
          title={t("visit.stockTooltip")}
        >
          {t("visit.stock")} — {t("visit.stockSoon")}
        </Button>
      </div>

      {message !== null && (
        <p role="status" data-testid="end-visit-message" className="text-sm text-ink-muted">
          {message}
        </p>
      )}
    </section>
  );
}
