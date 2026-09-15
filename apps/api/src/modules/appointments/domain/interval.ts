/**
 * Half-open interval algebra, `[start, end)`, over plain numbers.
 *
 * Used twice at different scales and deliberately unaware of both: wall-clock minutes from a
 * session's anchor midnight (which may exceed 1440 when a session crosses midnight), and
 * milliseconds since the epoch. Keeping it numeric is what lets the same tested code do the
 * subtraction in wall-clock space and again in instant space.
 *
 * Half-open matters at every boundary in this module: a slot ending exactly when a break begins
 * does not overlap it, and an appointment ending at 10:00 leaves 10:00 free.
 */

export interface Interval {
  start: number;
  end: number;
}

/** Empty and inverted intervals are dropped rather than rejected — see `union` on tolerance. */
const isNonEmpty = (i: Interval): boolean => i.end > i.start;

/**
 * Merge overlapping and touching intervals into a sorted, disjoint set.
 *
 * **Tolerant of malformed input by design** (PHASE-2.md Q6/Q10): the engine is handed whatever the
 * database holds, and a pure function that throws on one bad row entered last month would make a
 * doctor's whole day un-bookable at 9am. Rejection belongs on the write path, where a human is
 * present to fix it.
 *
 * Touching intervals merge (`[0,10)` and `[10,20)` become `[0,20)`) because two adjacent working
 * windows are one continuous session, and a slot should be allowed to span the join.
 */
export function union(intervals: Interval[]): Interval[] {
  const sorted = intervals.filter(isNonEmpty).sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: Interval[] = [];
  for (const current of sorted) {
    const last = merged[merged.length - 1];
    if (last !== undefined && current.start <= last.end) {
      if (current.end > last.end) last.end = current.end;
    } else {
      merged.push({ start: current.start, end: current.end });
    }
  }
  return merged;
}

/**
 * `base` minus `cuts`. Both are unioned first, so callers need not pre-normalise and overlapping
 * cuts subtract once rather than compounding.
 *
 * A cut lying entirely outside every base interval is silently ignored — a break recorded outside
 * its template's hours removes nothing, which is the tolerant half of Q10.
 */
export function subtract(base: Interval[], cuts: Interval[]): Interval[] {
  const holes = union(cuts);
  let remaining = union(base);

  for (const hole of holes) {
    const next: Interval[] = [];
    for (const piece of remaining) {
      if (hole.end <= piece.start || hole.start >= piece.end) {
        next.push(piece); // disjoint
        continue;
      }
      if (hole.start > piece.start) next.push({ start: piece.start, end: hole.start });
      if (hole.end < piece.end) next.push({ start: hole.end, end: piece.end });
    }
    remaining = next;
  }
  return remaining;
}
