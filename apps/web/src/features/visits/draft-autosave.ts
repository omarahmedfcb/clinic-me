// One autosaver per draft, outside React — Q17's "the store is per draft, never a single slot", and
// Q35's tab bar. A saver survives its screen unmounting, so switching tabs cannot swallow a save.

import { forget, type DraftText } from "./draft-store.ts";
import { saveDraft, type DraftField } from "./draft-api.ts";
import type { Vitals } from "../../domain/vitals.ts";

type AuthFetch = (path: string, init?: RequestInit) => Promise<Response>;

export type SaveState =
  | { kind: "idle" }
  | { kind: "unsaved" }
  | { kind: "saving" }
  | { kind: "saved"; at: Date }
  | { kind: "failed" }
  | { kind: "stale" };

export type DraftPatch = Partial<Record<DraftField, string>> & { vitals?: Vitals };

interface SaverContext {
  authFetch: AuthFetch;
  appointmentId: string;
  delayMs: number;
}

/**
 * Why this lives in a module map rather than in component state.
 *
 * The screen used to own the debounce timer, so unmounting it — which is what switching tabs does —
 * cleared the timer and the queued text went nowhere until something else happened to save. Q35 says
 * switching tabs must never flush **or block** the other draft's autosave, and both halves of that
 * are only true if the timer outlives the component. Q17 already said the same thing about the local
 * copy: per draft, never a single slot.
 *
 * The map is keyed by visit id, so two drafts have two independent timers, two independent pending
 * patches and two independent states — which is the property the tab bar renders and the property a
 * failing save on one tab must not touch on the other.
 */
class Saver {
  state: SaveState = { kind: "idle" };
  revision = 0;

  private pending: DraftPatch = {};
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    readonly visitId: string,
    private context: SaverContext,
  ) {}

  /** A remounted screen brings a fresh `authFetch`; the queued work and the state are kept. */
  rebind(context: SaverContext): void {
    this.context = context;
  }

  private announce(state: SaveState): void {
    this.state = state;
    notify();
  }

  queue(patch: DraftPatch): void {
    this.pending = { ...this.pending, ...patch };
    // A stale draft stays stale until it is reloaded: saying "unsaved" would suggest typing more
    // will fix it, and it will not.
    if (this.state.kind !== "stale") this.announce({ kind: "unsaved" });

    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), this.context.delayMs);
  }

  async flush(): Promise<void> {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const patch = this.pending;
    if (Object.keys(patch).length === 0) return;
    this.pending = {};
    this.announce({ kind: "saving" });

    const result = await saveDraft(
      this.context.authFetch,
      this.context.appointmentId,
      this.visitId,
      this.revision,
      patch,
    );
    if (result.ok) {
      this.revision = result.draft.revision;
      // Only now is the local copy redundant. Clearing it earlier would lose text on a failed save.
      forget(this.visitId);
      this.announce({ kind: "saved", at: new Date() });
      return;
    }
    // Put the text back so a later save still carries it, and never claim it was saved.
    this.pending = { ...patch, ...this.pending };
    this.announce(result.reason === "STALE" ? { kind: "stale" } : { kind: "failed" });
  }
}

const savers = new Map<string, Saver>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

export function saverFor(visitId: string, context: SaverContext): Saver {
  const existing = savers.get(visitId);
  if (existing !== undefined) {
    existing.rebind(context);
    return existing;
  }
  const saver = new Saver(visitId, context);
  savers.set(visitId, saver);
  return saver;
}

export function saveStateOf(visitId: string): SaveState | undefined {
  return savers.get(visitId)?.state;
}

export function subscribeToSaveStates(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Dropped once the visit is finished; a completed visit has nothing left to autosave. */
export function releaseSaver(visitId: string): void {
  savers.delete(visitId);
  notify();
}

/**
 * Tests only: the map is module state, and one spec's savers must not reach the next.
 *
 * Listeners are deliberately **not** cleared. `OpenVisitTabs` registers one at module load to keep
 * its version counter moving, and dropping it would leave the tab strip silently frozen for every
 * test after the first — a reset that breaks the thing it is resetting for.
 */
export function resetSavers(): void {
  savers.clear();
  notify();
}

export type { DraftText };
