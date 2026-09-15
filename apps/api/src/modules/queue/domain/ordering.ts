/**
 * The order patients are seen in — `PHASE-3.md` Q3.
 *
 * ## This is deliberately one function, because the answer is not known yet
 *
 * Q3 is **open by ruling**: whether a queue is ordered by arrival or by appointment time is a
 * question about a real reception desk, not one to settle by reasoning, and it is flagged for the
 * pilot. The default here is arrival order and **the default is not a finding.**
 *
 * So the whole rule lives in one pure function that every caller goes through. Switching it after
 * the pilot has to be one edit and a changed test — not a hunt through the service, the endpoint
 * and the screen for three places that each re-implemented "sort the queue".
 *
 * ## The two candidates, and what each costs
 *
 * - `ARRIVAL` — matches the physical fact of a waiting room. Someone who has sat for forty minutes
 *   watching later arrivals go in will not accept "your appointment was later". **Costs:** a
 *   punctual patient can be seen after a late one who happened to arrive first.
 * - `SCHEDULE` — fair by the appointment book, and rewards punctuality. **Costs:** unfair by the
 *   waiting room, which is the room the argument actually happens in.
 *
 * ## Ties
 *
 * Two patients can share an `arrived_at` to the millisecond — a receptionist checking in a couple
 * one after the other, or two clients acting at once. Ties break on `scheduledStart`, then on
 * `appointmentId`, so the order is **total**: the same rows always produce the same sequence. An
 * unstable queue that reshuffles between two polls a second apart is worse than a wrong order,
 * because the receptionist cannot trust either reading.
 */

export type QueueOrdering = "ARRIVAL" | "SCHEDULE";

/**
 * Arrival, pending the pilot. Named rather than inlined so that the place to change it is
 * findable by searching for the concept rather than for a string literal.
 */
export const DEFAULT_QUEUE_ORDERING: QueueOrdering = "ARRIVAL";

export interface QueueOrderable {
  appointmentId: string;
  scheduledStart: Date;
  /** Null until check-in. A booked patient who has not walked in yet has no arrival time. */
  arrivedAt: Date | null;
}

/** Compares two possibly-null instants, sorting nulls last. */
function byInstant(a: Date | null, b: Date | null): number {
  if (a === null && b === null) return 0;
  // Not yet arrived sorts after everyone who has: they are not in the room.
  if (a === null) return 1;
  if (b === null) return -1;
  return a.getTime() - b.getTime();
}

/**
 * Orders a queue. Pure, total, and stable for equal keys.
 *
 * Does not mutate its argument: the caller usually holds the rows for other purposes, and a sort
 * that quietly reorders someone else's array is the kind of shared-state bug that shows up two
 * screens away.
 */
export function orderQueue<T extends QueueOrderable>(
  rows: readonly T[],
  ordering: QueueOrdering = DEFAULT_QUEUE_ORDERING,
): T[] {
  return [...rows].sort((a, b) => {
    const primary =
      ordering === "ARRIVAL"
        ? byInstant(a.arrivedAt, b.arrivedAt)
        : a.scheduledStart.getTime() - b.scheduledStart.getTime();
    if (primary !== 0) return primary;

    const secondary =
      ordering === "ARRIVAL"
        ? a.scheduledStart.getTime() - b.scheduledStart.getTime()
        : byInstant(a.arrivedAt, b.arrivedAt);
    if (secondary !== 0) return secondary;

    // The last resort, so the order is total rather than merely mostly-determined. Ids are UUIDv7,
    // so this also happens to be creation order.
    return a.appointmentId < b.appointmentId ? -1 : a.appointmentId > b.appointmentId ? 1 : 0;
  });
}
