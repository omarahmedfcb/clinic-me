// The parts of a backup run that are decisions rather than I/O: what an artefact is called, whether
// a file is big enough to be a backup, and which stored objects a retention policy keeps.

/** Bytes below which an artefact is not a backup. A compressed empty dump is ~1.5kB; an empty tar ~45B. */
export const SIZE_FLOORS = { dump: 100_000, attachments: 1_000 };

export const DAILY_RETAINED = 30;
export const MONTHLY_RETAINED = 12;

const TWO = (value) => String(value).padStart(2, "0");

/** `YYYYMMDDTHHMMSSZ`. UTC always: a server that changes offset must not reorder its own backups. */
export function stampFor(instant) {
  return (
    `${instant.getUTCFullYear()}${TWO(instant.getUTCMonth() + 1)}${TWO(instant.getUTCDate())}` +
    `T${TWO(instant.getUTCHours())}${TWO(instant.getUTCMinutes())}${TWO(instant.getUTCSeconds())}Z`
  );
}

const STAMP = /(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/;

/** The instant encoded in an object key, or null when the key is not ours. Never throws on junk. */
export function parseStamp(key) {
  const found = STAMP.exec(key);
  if (found === null) return null;
  const [, year, month, day, hour, minute, second] = found;
  const at = new Date(
    Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second)),
  );
  return Number.isNaN(at.getTime()) ? null : at;
}

export function artefactNames(stamp) {
  return { dump: `clinic-os-${stamp}.dump.age`, attachments: `clinic-os-attachments-${stamp}.tar.gz.age` };
}

/** Which artefact a key is, or null when it is not ours. Attachments first: both start `clinic-os-`. */
export function kindOf(key) {
  if (/^clinic-os-attachments-\d{8}T\d{6}Z\.tar\.gz\.age$/.test(key)) return "attachments";
  if (/^clinic-os-\d{8}T\d{6}Z\.dump\.age$/.test(key)) return "dump";
  return null;
}

/**
 * Whether `bytes` clears the floor for `kind`. Returns a reason when it does not, null when it does.
 */
export function checkSize(kind, bytes) {
  const floor = SIZE_FLOORS[kind];
  if (floor === undefined) return `Unknown artefact kind "${kind}".`;
  if (!Number.isFinite(bytes) || bytes < 0) return `${kind}: size "${bytes}" is not a byte count.`;
  if (bytes < floor) {
    return `${kind}: ${bytes} bytes is below the ${floor}-byte floor — refusing to keep a file that is not a backup.`;
  }
  return null;
}

const dayKey = (at) => `${at.getUTCFullYear()}-${TWO(at.getUTCMonth() + 1)}-${TWO(at.getUTCDate())}`;
const monthKey = (at) => `${at.getUTCFullYear()}-${TWO(at.getUTCMonth() + 1)}`;

/** The keep-set for one artefact kind, newest first. Extracted so each kind is counted separately. */
function keepWithinKind(dated, referenceDate) {
  const keep = new Set();
  const days = new Set();
  const months = new Set();

  for (const { key, at } of dated) {
    if (at.getTime() > referenceDate.getTime()) {
      // Dated after the run that is pruning: another host's backup, or a clock that moved. Not ours
      // to delete on a retention rule, so it is kept and reported.
      keep.add(key);
      continue;
    }
    const day = dayKey(at);
    if (!days.has(day) && days.size < DAILY_RETAINED) {
      days.add(day);
      keep.add(key);
    }
    const month = monthKey(at);
    if (!months.has(month) && months.size < MONTHLY_RETAINED) {
      months.add(month);
      keep.add(key);
    }
  }
  return keep;
}

/**
 * Splits stored object keys into those a `30 daily + 12 monthly` policy keeps and those it expires.
 *
 * Counted **per artefact kind**: a night's dump and its attachment archive share a stamp, so a
 * single pool would read them as two copies of one backup and keep one — silently dropping the
 * attachments half of every backup, which is the gap DEPLOY.md §7 exists to close.
 *
 * `referenceDate` is a parameter and the clock is never read here: a retention policy that deletes
 * the clinic's only copy of its data must be reproducible in a test, not a function of when it ran.
 */
export function selectForRetention(keys, referenceDate) {
  const byKind = new Map();
  const unparsed = [];
  for (const key of keys) {
    const kind = kindOf(key);
    const at = kind === null ? null : parseStamp(key);
    if (kind === null || at === null) {
      unparsed.push(key);
      continue;
    }
    if (!byKind.has(kind)) byKind.set(kind, []);
    byKind.get(kind).push({ key, at });
  }

  const keep = [];
  const expire = [];
  for (const dated of byKind.values()) {
    // Newest first, so the first key seen for a day or a month is the one that day or month keeps.
    dated.sort((left, right) => right.at.getTime() - left.at.getTime());
    const kept = keepWithinKind(dated, referenceDate);
    for (const { key } of dated) (kept.has(key) ? keep : expire).push(key);
  }

  return { keep, expire, unparsed };
}
