// Types for verify.mjs, the restore drill's judgements. Plain JavaScript for the same reason
// plan.mjs is: the drill runs with bare node on a server that has no build step.

export interface BackupPair {
  stamp: string;
  at: Date;
  dump: string;
  attachments: string;
}

/** The newest stamp for which both artefacts exist, or null when no pair is complete. */
export function newestCompletePair(keys: string[]): BackupPair | null;

/** Human-readable problems, one per disagreeing table. Empty means the counts match exactly. */
export function compareRowCounts(source: Record<string, number>, restored: Record<string, number>): string[];

export interface StorageKeySplit {
  /** Referenced by the restored database and absent from the archive. These fail the drill. */
  missing: string[];
  /** In the archive and referenced by nothing. Tolerated — DEPLOY.md §7's deliberate ordering. */
  orphans: string[];
}

export function compareStorageKeys(input: {
  referenced: readonly string[];
  restoredFiles: readonly string[];
}): StorageKeySplit;

export function storageKeyProblems(input: {
  referenced: readonly string[];
  restoredFiles: readonly string[];
}): string[];

export function compareDigests(source: Record<string, string>, restored: Record<string, string>): string[];
