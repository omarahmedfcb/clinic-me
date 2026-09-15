// The doctor's open consultations as tabs — Q35. Each tab shows its own draft's save state.
// Switching tabs neither flushes nor blocks the other draft: the savers live outside these components.

import { useEffect, useState, useSyncExternalStore } from "react";
import { useLocale } from "../../i18n/locale-context.tsx";
import type { TranslationKey } from "../../i18n/strings.ts";
import { saveStateOf, subscribeToSaveStates, type SaveState } from "./draft-autosave.ts";
import { openVisit } from "./open-visit.ts";

type AuthFetch = (path: string, init?: RequestInit) => Promise<Response>;

export interface OpenVisit {
  appointmentId: string;
  patientId: string;
  patientName: string;
  status: "IN_CONSULTATION" | "PAUSED";
  visitId: string | null;
}

/**
 * Anything that is not an array is treated as no tabs.
 *
 * A type is a claim about a payload, not a validation of one — the lesson `CoverageBadge` records
 * from the day a built frontend met an older API and `coverage.standing` took the whole queue board
 * down. A tab strip must never be the reason a doctor cannot reach the visit they are typing into.
 */
export async function loadOpenVisits(authFetch: AuthFetch): Promise<OpenVisit[]> {
  const response = await authFetch("/api/visits/open");
  if (!response.ok) return [];
  const body: unknown = await response.json();
  return Array.isArray(body) ? (body as OpenVisit[]) : [];
}

/** The short form for a tab. The full sentence belongs on the screen, not on a strip of tabs. */
function tabStateKey(state: SaveState | undefined): TranslationKey | null {
  if (state === undefined) return null;
  switch (state.kind) {
    case "idle":
      return null;
    case "unsaved":
      return "tabs.unsaved";
    case "saving":
      return "tabs.saving";
    case "saved":
      return "tabs.saved";
    case "failed":
      return "tabs.failed";
    case "stale":
      return "tabs.stale";
  }
}

export function OpenVisitTabs({
  authFetch,
  currentAppointmentId,
}: {
  authFetch: AuthFetch;
  currentAppointmentId: string;
}) {
  const [visits, setVisits] = useState<OpenVisit[]>([]);

  useEffect(() => {
    let cancelled = false;
    void loadOpenVisits(authFetch).then((value) => {
      if (!cancelled) setVisits(value);
    });
    return () => {
      cancelled = true;
    };
  }, [authFetch, currentAppointmentId]);

  // One open visit is not a set of tabs, it is the screen you are on. The consultations screen
  // renders the same list with this rule off, because there it is the content rather than a strip.
  if (visits.length < 2) return null;

  return <OpenVisitTabList visits={visits} currentAppointmentId={currentAppointmentId} />;
}

/** The strip itself. Shared so the tab bar and the consultations screen cannot drift apart. */
export function OpenVisitTabList({
  visits,
  currentAppointmentId,
}: {
  visits: OpenVisit[];
  currentAppointmentId: string | null;
}) {
  const { t } = useLocale();

  // Subscribed rather than polled: a save state changes on a keystroke's debounce, and a tab strip
  // that lagged behind the indicator two centimetres above it would be worse than no strip at all.
  const version = useSyncExternalStore(
    subscribeToSaveStates,
    () => savesVersion,
    () => savesVersion,
  );

  return (
    <nav
      aria-label={t("tabs.label")}
      data-testid="open-visit-tabs"
      data-version={version}
      className="mb-3 flex flex-wrap gap-2"
    >
      {visits.map((visit) => {
        const current = visit.appointmentId === currentAppointmentId;
        const stateKey = visit.visitId === null ? null : tabStateKey(saveStateOf(visit.visitId));
        return (
          <button
            key={visit.appointmentId}
            type="button"
            data-testid={`visit-tab-${visit.appointmentId}`}
            data-current={current ? "true" : "false"}
            aria-current={current ? "page" : undefined}
            onClick={() => {
              // No flush: the other draft's saver owns its own timer and keeps it (Q35).
              if (!current) openVisit(visit.appointmentId);
            }}
            className={
              current
                ? "rounded-lg border border-primary bg-primary-soft px-3 py-1.5 text-sm text-primary"
                : "rounded-lg border border-border bg-surface px-3 py-1.5 text-sm text-ink-muted hover:bg-surface-sunken"
            }
          >
            <span className="font-medium">{visit.patientName}</span>
            {visit.status === "PAUSED" && (
              <span className="ms-2 text-xs text-info">{t("appointment.status.PAUSED")}</span>
            )}
            {stateKey !== null && (
              <span data-testid={`visit-tab-state-${visit.appointmentId}`} className="ms-2 text-xs">
                {t(stateKey)}
              </span>
            )}
          </button>
        );
      })}
    </nav>
  );
}

/**
 * A counter the store bumps, so `useSyncExternalStore` has a stable snapshot to compare.
 *
 * Returning the state objects themselves would allocate a new value every render and loop forever;
 * a version number changes exactly when something announced a change.
 */
let savesVersion = 0;
subscribeToSaveStates(() => {
  savesVersion += 1;
});
