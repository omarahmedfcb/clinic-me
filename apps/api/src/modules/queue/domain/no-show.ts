/**
 * When a patient becomes markable as absent — `PHASE-3.md` Q9.
 *
 * ## The grace period runs from readiness, not from the appointment time
 *
 * The obvious rule is `scheduled_start + grace`, and it is wrong in the ordinary case rather than
 * in an exotic one: the doctor is running ninety minutes behind, the patient is sitting in the
 * waiting room, and their grace period expired an hour ago because the appointment book said
 * 10:00. Nothing about that patient is absent.
 *
 * So the reference is **the later of** the appointment's start and the moment that doctor last
 * became free. A patient is a candidate for absence only once the clinic was actually ready for
 * them.
 *
 * ## Why this is pure, and where the reading happens
 *
 * "That doctor's last consultation end" is a database question, so the caller reads it and passes
 * it in. `domain/` has zero I/O — a query in this file would be the design going wrong, the same
 * rule the slot engine is held to.
 *
 * ## This decides candidacy, not outcome
 *
 * Q8 rules that **the job proposes and a human disposes**: nothing here or downstream of it writes
 * a terminal status. This function answers "should a person be asked about this appointment?" and
 * that is all it answers. See `queue.service.ts` for why automating the answer is refused.
 */

export interface NoShowCandidacyInput {
  scheduledStart: Date;
  /**
   * When that doctor's previous consultation ended, or null if they have not seen anyone today.
   * Read by the caller — see above.
   */
  doctorFreeAt: Date | null;
  /** From `tenants.no_show_grace_minutes`. */
  graceMinutes: number;
  /** Passed in, never read from the clock. */
  now: Date;
}

/**
 * The instant the grace period is measured from: the later of the appointment's start and the
 * doctor becoming free.
 *
 * Exported separately from the predicate because it is also what a caller passes to
 * `transition()` as `graceReference`, and because a message telling a receptionist *why* an
 * appointment is not yet markable has to name this instant.
 */
export function graceReferenceInstant(scheduledStart: Date, doctorFreeAt: Date | null): Date {
  if (doctorFreeAt === null) return scheduledStart;
  return doctorFreeAt.getTime() > scheduledStart.getTime() ? doctorFreeAt : scheduledStart;
}

/** The instant from which the appointment could be marked absent. */
export function noShowEligibleAt(input: Omit<NoShowCandidacyInput, "now">): Date {
  const reference = graceReferenceInstant(input.scheduledStart, input.doctorFreeAt);
  return new Date(reference.getTime() + input.graceMinutes * 60_000);
}

/**
 * Whether this appointment should appear on the list a human reviews.
 *
 * Note what is *not* here: any notion of the patient being present. The system cannot know that,
 * which is the whole reason Q8 keeps a person in the loop — a candidate is a question, never a
 * verdict.
 */
export function isNoShowCandidate(input: NoShowCandidacyInput): boolean {
  return input.now.getTime() >= noShowEligibleAt(input).getTime();
}
