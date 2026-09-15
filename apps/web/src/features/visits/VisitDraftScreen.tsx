// The visit screen: one screen, free text, autosave under compare-and-set, and the act that ends it.
// Q1, Q3, Q4, Q5, Q7, Q17, restructured by Q21-Q27.

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { Textarea } from "../../design-system/fields.tsx";
import { Button } from "../../design-system/Button.tsx";
import { intlLocale } from "../../i18n/format.ts";
import { useLocale } from "../../i18n/locale-context.tsx";
import type { TranslationKey } from "../../i18n/strings.ts";
import { DRAFT_FIELDS, openDraft, type DraftField, type VisitDraft } from "./draft-api.ts";
import {
  releaseSaver,
  saverFor,
  subscribeToSaveStates,
  type SaveState,
} from "./draft-autosave.ts";
import { OpenVisitTabs } from "./OpenVisitTabs.tsx";
import { recall, recoverable, remember, type DraftText } from "./draft-store.ts";
import { VitalsSection } from "./VitalsSection.tsx";
import { ClinicalProfileSection } from "./ClinicalProfileSection.tsx";
import { PatientHeader } from "./PatientHeader.tsx";
import { InvestigationsSection, PrescriptionSection } from "./OrdersSection.tsx";
import { ProceduresSection } from "./ProceduresSection.tsx";
import { AttachmentsSection } from "./AttachmentsSection.tsx";
import { SickLeaveSection } from "./SickLeaveSection.tsx";
import { NO_SICK_LEAVE, type SickLeave } from "./sick-leave-api.ts";
import { EndVisitSection } from "./EndVisitSection.tsx";
import { VisitTotalSection } from "./VisitTotalSection.tsx";
import { PrintSection } from "./PrintSection.tsx";
import type { Vitals } from "../../domain/vitals.ts";

type AuthFetch = (path: string, init?: RequestInit) => Promise<Response>;

/** Q5 states the guarantee modestly on purpose: everything older than about two seconds. */
export const AUTOSAVE_DELAY_MS = 2000;

const IDLE: SaveState = { kind: "idle" };

export type { SaveState };

/** The indicator's words. Never says "saved" unless the server confirmed this text. */
export function saveStateKey(state: SaveState): TranslationKey {
  switch (state.kind) {
    case "idle":
      return "draft.status.idle";
    case "unsaved":
      return "draft.status.unsaved";
    case "saving":
      return "draft.status.saving";
    case "saved":
      return "draft.status.saved";
    case "failed":
      return "draft.status.failed";
    case "stale":
      return "draft.status.stale";
  }
}

interface Props {
  authFetch: AuthFetch;
  appointmentId: string;
  /** From `tenants.currency` via the session. Never assumed — money is formatted with it. */
  currency?: string;
  /** Injected so a test can drive the clock and the delay without waiting two seconds. */
  delayMs?: number;
}

export function VisitDraftScreen({
  authFetch,
  appointmentId,
  currency = "EGP",
  delayMs = AUTOSAVE_DELAY_MS,
}: Props) {
  const { t, locale } = useLocale();
  const [draft, setDraft] = useState<VisitDraft | null>(null);
  const [openError, setOpenError] = useState<TranslationKey | null>(null);
  const [text, setText] = useState<DraftText>({});
  const [recovered, setRecovered] = useState(false);
  const [vitals, setVitals] = useState<Vitals>({});
  const [completed, setCompleted] = useState(false);
  const [followUpDate, setFollowUpDate] = useState<string | null>(null);
  // Lifted so the print sheets carry the certificate without fetching it a second time (Q46).
  const [sickLeave, setSickLeave] = useState<SickLeave>(NO_SICK_LEAVE);

  /**
   * The saver, not a timer of our own. It lives in `draft-autosave.ts` and outlives this component,
   * which is what makes switching tabs safe: an unmount used to clear the debounce and swallow the
   * queued text (Q35, and Q17's "per draft, never a single slot").
   */
  const saver = draft === null ? null : saverFor(draft.id, { authFetch, appointmentId, delayMs });

  const state = useSyncExternalStore(
    subscribeToSaveStates,
    () => saver?.state ?? IDLE,
    () => saver?.state ?? IDLE,
  );

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const result = await openDraft(authFetch, appointmentId);
      if (cancelled) return;
      if (!result.ok) {
        setOpenError(
          result.reason === "NOT_PRESENT"
            ? "draft.notPresent"
            : result.reason === "NOT_A_DOCTOR"
              ? "draft.notADoctor"
              : "draft.openFailed",
        );
        return;
      }
      const server: DraftText = {};
      for (const field of DRAFT_FIELDS) server[field] = result.draft[field] ?? "";
      const restored = recoverable(recall(result.draft.id), result.draft.revision, server);
      saverFor(result.draft.id, { authFetch, appointmentId, delayMs }).revision = result.draft.revision;
      setDraft(result.draft);
      setText(restored.text);
      setVitals((result.draft.vitals ?? {}) as Vitals);
      setRecovered(restored.recovered);
      // Recovered text has not reached the server, so it is queued rather than merely announced.
      if (restored.recovered) {
        saverFor(result.draft.id, { authFetch, appointmentId, delayMs }).queue(restored.text);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [authFetch, appointmentId]);

  const flush = useCallback(async () => {
    await saver?.flush();
  }, [saver]);

  const edit = (field: DraftField, value: string) => {
    if (saver === null) return;
    setText((previous) => {
      const next = { ...previous, [field]: value };
      remember(saver.visitId, saver.revision, next, new Date());
      return next;
    });
    saver.queue({ [field]: value });
  };

  if (openError !== null) {
    return (
      <main className="mx-auto max-w-3xl p-6">
        <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
          {t(openError)}
        </p>
      </main>
    );
  }

  if (draft === null) {
    return <main className="mx-auto max-w-3xl p-6 text-sm text-ink-muted">{t("draft.opening")}</main>;
  }

  const savedAt = state.kind === "saved" ? state.at.toLocaleTimeString(intlLocale(locale)) : "";

  return (
    <main className="mx-auto max-w-3xl p-6">
      <OpenVisitTabs authFetch={authFetch} currentAppointmentId={appointmentId} />
      <PatientHeader authFetch={authFetch} appointmentId={appointmentId} />

      <div className="mb-4 flex items-baseline justify-between gap-3">
        <h2 className="text-base font-semibold text-ink">{t("draft.title")}</h2>
        <p
          // aria-live so a screen reader hears the state change without hunting for it. Not
          // assertive: a save indicator must not interrupt dictation of clinical text.
          aria-live="polite"
          data-testid="save-state"
          data-state={state.kind}
          className={
            state.kind === "failed" || state.kind === "stale"
              ? "text-sm text-danger"
              : "text-sm text-ink-muted"
          }
        >
          {t(saveStateKey(state)).replace("{at}", savedAt)}
        </p>
      </div>

      {draft.resumed && !recovered && (
        <p className="mb-3 rounded-lg bg-surface-sunken px-3 py-2 text-xs text-ink-muted">
          {t("draft.resumed").replace("{at}", new Date(draft.updatedAt).toLocaleString(intlLocale(locale)))}
        </p>
      )}
      {recovered && (
        <p className="mb-3 rounded-lg bg-warning-soft px-3 py-2 text-xs text-ink" data-testid="recovered">
          {t("draft.recovered")}
        </p>
      )}

      <div className="mb-4 grid gap-4">
        <ClinicalProfileSection authFetch={authFetch} appointmentId={appointmentId} />
        <VitalsSection
          vitals={vitals}
          previous={(draft.previousVitals ?? {}) as Vitals}
          patientDateOfBirth={draft.patientDateOfBirth ?? null}
          onChange={(next) => {
            setVitals(next);
            saver?.queue({ vitals: next });
          }}
        />
      </div>

      <form className="grid gap-4" onSubmit={(event) => event.preventDefault()}>
        {DRAFT_FIELDS.map((field) => (
          <Textarea
            key={field}
            label={t(`draft.field.${field}` as TranslationKey)}
            value={text[field] ?? ""}
            rows={field === "doctorNotes" || field === "treatmentPlan" ? 5 : 3}
            // A finished visit is corrected through an amendment with a reason (Q6), never by
            // typing into it — so the fields close rather than autosaving into a refusal.
            disabled={completed}
            onChange={(event) => edit(field, event.target.value)}
          />
        ))}
      </form>

      {!completed && (state.kind === "failed" || state.kind === "stale") && (
        <div className="mt-4">
          <Button type="button" onClick={() => void flush()}>
            {t("draft.retry")}
          </Button>
        </div>
      )}

      <div className="mt-4 grid gap-4">
        <InvestigationsSection authFetch={authFetch} appointmentId={appointmentId} visitId={draft.id} />
        <PrescriptionSection authFetch={authFetch} appointmentId={appointmentId} visitId={draft.id} />
        <ProceduresSection
          authFetch={authFetch}
          appointmentId={appointmentId}
          visitId={draft.id}
          currency={currency}
        />
        {/* Q46: recorded on the visit, printed as its own page in the prescription's print job. */}
        <SickLeaveSection
          authFetch={authFetch}
          appointmentId={appointmentId}
          visitId={draft.id}
          onChange={setSickLeave}
        />
        {/* PR 9, pulled forward: the backend has existed since Q10 with nothing calling it. */}
        <AttachmentsSection authFetch={authFetch} appointmentId={appointmentId} visitId={draft.id} />
        {/* R1: the total sits immediately above «إنهاء الزيارة», because that is the moment it is
            decided — after completion the charge is written and the lines are frozen. */}
        <VisitTotalSection
          authFetch={authFetch}
          appointmentId={appointmentId}
          visitId={draft.id}
          currency={currency}
        />
      </div>

      {/* Kept mounted after completion: it carries the sentence saying whether the follow-up was
          booked, and unmounting it would take that answer away the instant it arrived. */}
      <EndVisitSection
        authFetch={authFetch}
        appointmentId={appointmentId}
        visitId={draft.id}
        revision={() => saver?.revision ?? 0}
        flush={flush}
        onCompleted={(finished) => {
          setCompleted(true);
          setFollowUpDate(finished.followUpDate);
          // A finished visit has nothing left to autosave, and a saver left in the map would keep
          // the tab bar reporting a draft that no longer exists.
          releaseSaver(finished.visitId);
        }}
      />

      {/* Q9: printing is the delivery mechanism, and the sheets carry what is on the screen now. */}
      <PrintSection
        authFetch={authFetch}
        appointmentId={appointmentId}
        visitId={draft.id}
        doctorId={draft.doctorId}
        text={text}
        followUpDate={followUpDate}
        sickLeave={sickLeave}
      />
    </main>
  );
}
