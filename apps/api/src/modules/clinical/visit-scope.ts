// A draft is private to its author; a completed visit is visible to any reader already past access.
// Every read of `visits` spreads this — visit-readers-are-scoped.spec.ts fails the build if one does not.

export interface VisitScopeCaller {
  actor: { userId: string };
}

export function visitScope(caller: VisitScopeCaller) {
  return {
    OR: [
      { status: "COMPLETED" as const },
      { status: "DRAFT" as const, createdBy: caller.actor.userId },
    ],
  };
}

/**
 * The queue's scope: the visit belonging to the **appointment's own doctor**, whatever its status.
 *
 * Deliberately not `visitScope`. Reception is not the draft's author, so the author filter would
 * report "no visit" for exactly the case Q14 exists to show — a visit in progress. What that costs
 * is bounded by what may be selected through it: the status column and nothing else, which
 * `queue-dto-allow-list.spec.ts` fails the build over. Another doctor's draft on the same
 * appointment (Q15) is not reception's business and is excluded by the doctor filter.
 */
export function appointmentDoctorScope(
  pairs: readonly { appointmentId: string; doctorId: string }[],
) {
  // Pair by pair, not two `IN` lists. A set-wide filter would admit doctor B's draft on doctor A's
  // appointment whenever B appears anywhere on the board, which is the ordinary case in a clinic
  // with two doctors — and it would leave this helper decorative while looking like a guard.
  return { OR: pairs.map(({ appointmentId, doctorId }) => ({ appointmentId, doctorId })) };
}
