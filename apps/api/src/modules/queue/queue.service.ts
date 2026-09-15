/**
 * The queue — `PHASE-3.md` §6.
 *
 * **This is the interface, not a controller's helper**, on the same terms as
 * `appointments.service.ts`: no NestJS types, failure is a value, and the caller supplies its
 * identity. The AI tool layer will call these directly.
 *
 * This file is the module's public surface. The implementation is split across three files
 * because it outgrew the ~300-line convention in `CLAUDE.md` before the controller was even
 * written, and checkpoint 4 adds to it:
 *
 * | | |
 * |---|---|
 * | `queue.types.ts` | the contracts callers depend on |
 * | `queue.moves.ts` | the state changes — every one a compare-and-set |
 * | `queue.queries.ts` | the reads, one of which writes nothing *by ruling* |
 * | `queue.readiness.ts` | when a doctor last became free, the database half of Q9 |
 *
 * Importing from here rather than from those files keeps the seam an implementation detail: the
 * controller, the tests and the later AI tool layer all name one module.
 *
 * ## Compare-and-set, and the case the state machine cannot see (Q2)
 *
 * Every mutation takes an `expectedStatus`. If the row has moved on, it refuses with
 * `QUEUE_MOVED_ON` rather than applying.
 *
 * This is not belt-and-braces over `transition()`. It closes a hole the state machine
 * *structurally cannot*: `ARRIVED → WAITING` applied twice by two clients is **legal both times**.
 * The machine sees a legal edge on each call and approves both, and without a compare-and-set the
 * second silently overwrites the first `waiting_started_at` — quietly changing the queue's order,
 * with nothing anywhere recording that it did.
 *
 * It is a compare-and-set on one row, not a lock and not a queue-level version. The queue race is
 * two clients editing *different* rows, where both writes should succeed; a version over the whole
 * queue would manufacture conflicts between actions that do not conflict.
 *
 * ## Refusals are written for a receptionist
 *
 * `QUEUE_MOVED_ON` carries the current status and who moved it, so the caller can say "Dr Hisham
 * already started this patient" instead of "ILLEGAL_TRANSITION from IN_CONSULTATION". The second
 * sentence is true and useless.
 *
 * ## What this module deliberately does not do
 *
 * **It never marks anyone absent on its own.** `pendingNoShows()` is a read with no write path —
 * see the note on it in `queue.queries.ts`. Q8 is a ruling, not an implementation detail.
 */

export {
  checkIn,
  completeConsultation,
  markNoShow,
  markWaiting,
  pauseConsultation,
  resumeConsultation,
  startConsultation,
} from "./queue.moves.ts";

export {
  describeQueue,
  describeQueueForDate,
  pendingNoShows,
  pendingNoShowsForDate,
} from "./queue.queries.ts";

export {
  ON_QUEUE,
  type NoShowCandidate,
  type QueueEntry,
  type QueueMoveInput,
  type QueueMoveResult,
  type QueueQuery,
  type QueueRefusalReason,
} from "./queue.types.ts";
