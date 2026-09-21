// Types for plan.mjs, which stays plain JavaScript because the backup image runs it with bare node —
// there is no build step on a server whose job is to hold a copy of the data.

export type ArtefactKind = "dump" | "attachments";

export const SIZE_FLOORS: Record<ArtefactKind, number>;
export const DAILY_RETAINED: number;
export const MONTHLY_RETAINED: number;

export function stampFor(instant: Date): string;

/** The instant encoded in an object key, or null when the key is not one of ours. */
export function parseStamp(key: string): Date | null;

export function artefactNames(stamp: string): { dump: string; attachments: string };

/** Which artefact a key is, or null when it is not one of ours. */
export function kindOf(key: string): ArtefactKind | null;

/** A reason the artefact is too small to be a backup, or null when it clears the floor. */
export function checkSize(kind: string, bytes: number): string | null;

export interface RetentionSplit {
  keep: string[];
  expire: string[];
  /** Keys carrying no parseable stamp. Never expired — something else owns them. */
  unparsed: string[];
}

export function selectForRetention(keys: string[], referenceDate: Date): RetentionSplit;
