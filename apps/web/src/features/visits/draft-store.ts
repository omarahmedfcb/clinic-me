// Mirrors unsaved draft text per visit id so a kill loses at most the last keystrokes. Q5, Q17.
// Keyed per draft, never one slot: two open drafts must not overwrite each other's recovery copy.

import type { DraftField } from "./draft-api.ts";

export type DraftText = Partial<Record<DraftField, string>>;

export interface StoredDraft {
  visitId: string;
  /** The revision the text was typed against, so a stale recovery can be spotted. */
  revision: number;
  text: DraftText;
  savedAt: string;
}

const PREFIX = "clinic-os.visit-draft.";

const key = (visitId: string): string => `${PREFIX}${visitId}`;

/** Every accessor is wrapped: a private window or blocked site data throws rather than returning null. */
function safe<T>(read: () => T, fallback: T): T {
  try {
    return read();
  } catch {
    return fallback;
  }
}

export function remember(visitId: string, revision: number, text: DraftText, now: Date): void {
  safe(() => {
    window.localStorage.setItem(
      key(visitId),
      JSON.stringify({ visitId, revision, text, savedAt: now.toISOString() } satisfies StoredDraft),
    );
    return true;
  }, false);
}

export function recall(visitId: string): StoredDraft | null {
  return safe(() => {
    const raw = window.localStorage.getItem(key(visitId));
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as StoredDraft;
    return parsed.visitId === visitId ? parsed : null;
  }, null);
}

export function forget(visitId: string): void {
  safe(() => {
    window.localStorage.removeItem(key(visitId));
    return true;
  }, false);
}

/**
 * What the screen should show on open: the server's text, unless a local copy is ahead of it.
 *
 * "Ahead" means the local copy was typed against the revision the server is still on — text that
 * never reached the server. A local copy at an older revision is stale and is discarded, because
 * the server has since accepted something newer.
 */
export function recoverable(
  stored: StoredDraft | null,
  serverRevision: number,
  serverText: DraftText,
): { text: DraftText; recovered: boolean } {
  if (stored === null || stored.revision !== serverRevision) {
    return { text: serverText, recovered: false };
  }
  const differs = Object.keys(stored.text).some(
    (field) => (stored.text[field as DraftField] ?? "") !== (serverText[field as DraftField] ?? ""),
  );
  return differs ? { text: { ...serverText, ...stored.text }, recovered: true } : { text: serverText, recovered: false };
}
