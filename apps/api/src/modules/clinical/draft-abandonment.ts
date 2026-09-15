// Whether a draft has been abandoned. Q15: derived on read against a passed-in instant.
// Pure, and the clock is a parameter — a status flipped by a job grants "still open" forever if nobody writes it.

/**
 * How long a draft may sit untouched before it reads as abandoned.
 *
 * **Twenty-four hours is mine, not a ruling.** Q15 says abandonment is derived and says nothing
 * about the threshold. A day is chosen because it survives a doctor finishing a clinic late and
 * returning next morning, which a shorter window would call abandoned while they were still
 * working. Worth a founder's number once a real clinic has run a week.
 */
export const ABANDON_AFTER_HOURS = 24;

const HOUR_MS = 60 * 60 * 1000;

export interface AbandonableDraft {
  status: "DRAFT" | "COMPLETED";
  updatedAt: Date;
}

/**
 * Nothing is stored and no job runs. The answer is recomputed on every read, so it cannot be stale
 * and cannot be wrong because a sweep failed — which is D24's reasoning for transfer expiry,
 * applied to the same shape of problem.
 */
export function isAbandoned(
  draft: AbandonableDraft,
  now: Date,
  afterHours: number = ABANDON_AFTER_HOURS,
): boolean {
  // A finished visit is not abandoned however old it is. Abandonment is about unfinished work.
  if (draft.status !== "DRAFT") return false;
  return now.getTime() - draft.updatedAt.getTime() > afterHours * HOUR_MS;
}
