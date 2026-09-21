// The restore drill's judgements, with no I/O: which backup pair to restore, and whether what came
// back matches the source. A drill that only counts rows passes a backup that lost every file.

import { kindOf, parseStamp } from "./plan.mjs";

/**
 * The newest stamp for which BOTH artefacts exist.
 *
 * A dump whose attachment archive failed to upload is not a restorable backup, and picking the
 * newest of each independently would silently pair a dump with the previous night's files.
 */
export function newestCompletePair(keys) {
  const byStamp = new Map();
  for (const key of keys) {
    const kind = kindOf(key);
    const at = kind === null ? null : parseStamp(key);
    if (kind === null || at === null) continue;
    const stamp = key.replace(/^.*?(\d{8}T\d{6}Z).*$/, "$1");
    if (!byStamp.has(stamp)) byStamp.set(stamp, { stamp, at });
    byStamp.get(stamp)[kind] = key;
  }

  const complete = [...byStamp.values()].filter((entry) => entry.dump && entry.attachments);
  if (complete.length === 0) return null;
  complete.sort((left, right) => right.at.getTime() - left.at.getTime());
  return complete[0];
}

/** Tables present in one side and not the other, and tables whose counts differ. */
export function compareRowCounts(source, restored) {
  const problems = [];
  for (const [table, count] of Object.entries(source)) {
    if (!(table in restored)) problems.push(`${table}: missing from the restore (source has ${count})`);
    else if (restored[table] !== count) problems.push(`${table}: source ${count}, restored ${restored[table]}`);
  }
  for (const table of Object.keys(restored)) {
    if (!(table in source)) problems.push(`${table}: present in the restore and not in the source`);
  }
  return problems;
}

/**
 * Whether the restored files match both the source directory and the rows that point at them.
 *
 * The row count is the half DEPLOY.md §7 records as the old drill's blind spot: every `attachments`
 * row restores from the dump whether or not a single file came back with it.
 */
/**
 * Every storage key the restored database references must exist as a file. Extra files must not.
 *
 * **The asymmetry is DEPLOY.md §7's ordering choice, not an oversight.** The dump is taken before
 * the attachment archive, so a file uploaded between the two is in the archive and not in the
 * dump: an orphan file, which nothing in the product ever looks for. The reverse — a row whose
 * download fails — is the one a doctor sees, so only that direction fails the drill.
 *
 * Counting files against the `attachments` table alone was wrong and said so out loud on real
 * data: `clinic_os_review` has zero attachment rows and ten files, because the same storage root
 * also holds logos, signatures, stamps, profile photos and contracts. Six columns reference it.
 */
export function compareStorageKeys({ referenced, restoredFiles }) {
  const present = new Set(restoredFiles);
  const wanted = new Set(referenced);

  return {
    missing: [...wanted].filter((key) => !present.has(key)).sort(),
    orphans: restoredFiles.filter((file) => !wanted.has(file)).sort(),
  };
}

/** The problems that fail a drill. Orphans are reported by the caller, never failed on. */
export function storageKeyProblems({ referenced, restoredFiles }) {
  const { missing } = compareStorageKeys({ referenced, restoredFiles });
  return missing.map(
    (key) => `${key}: referenced by the restored database and absent from the attachment archive`,
  );
}

/** Digests that disagree, named by the path whose bytes changed. */
export function compareDigests(source, restored) {
  const problems = [];
  for (const [path, digest] of Object.entries(source)) {
    if (!(path in restored)) problems.push(`${path}: not in the restored archive`);
    else if (restored[path] !== digest) problems.push(`${path}: restored bytes differ from the source`);
  }
  return problems;
}
