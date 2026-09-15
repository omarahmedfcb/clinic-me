/**
 * Retrying a transaction Postgres killed to break a deadlock — `40P01`.
 *
 * ## Why this exists, and why it is not a generic retry
 *
 * `booking-concurrency.integration.spec.ts` had been failing about one run in ten since
 * 2026-08-29 with no error detail. It was instrumented on 2026-09-02 to report its rejections as
 * data, and on 2026-09-06 it finally named its own cause on CI — on a branch that touched none of
 * the booking code:
 *
 * ```
 * PrismaClientKnownRequestError P2039
 *   meta.driverAdapterError.cause.code = "40P01"   "deadlock detected"
 *   detail: "Process 257 waits for ShareLock on transaction 1715; blocked by ..."
 * ```
 *
 * It comes from the `no_double_booking` exclusion constraint, which is not a unique index and does
 * not get Postgres's speculative-insertion treatment: a conflicting inserter writes its index entry
 * and *then* scans for conflicts, so two transactions can each see the other's entry and each wait
 * on the other's transaction id. Postgres detects the cycle and kills one arbitrarily.
 *
 * **`PHASE-2.md` said "do not add a retry", and that rule was right for what was known then.** It
 * reads: *"Retrying a booking that may already have succeeded is how a patient gets two
 * appointments."* That is true of a timeout, a dropped connection, or a pool error — all of which
 * leave the caller unable to say whether the transaction committed.
 *
 * **A deadlock abort is different in kind, and that is the whole justification for this file.**
 * Postgres chooses a victim, rolls it back *completely*, and only then raises the error. There is
 * no "may already have succeeded" — the appointment row, its event row, its notification and its
 * audit rows are all gone before the caller sees `40P01`. So a retry cannot double-book. The
 * classifier below is therefore as narrow as `isDoubleBookingViolation`, and for the same reason:
 * it must recognise exactly the one shape whose semantics have been established, and rethrow
 * everything else.
 *
 * ## Why not mapping it straight to `SLOT_TAKEN`
 *
 * **Because a deadlock says nothing about the slot.** The first version of this note claimed the
 * victim's slots are still free after the abort; the reproducer disproved it — the survivor commits
 * and takes them. Corrected here rather than quietly softened, because the corrected argument is
 * the stronger one and the wrong version would have read as verified.
 *
 * What the abort establishes is only this: the victim's own writes are gone. Whether the slot is
 * gone too depends entirely on what the *other* transaction did, and the error carries nothing
 * about that. Answering "that time was just taken" would therefore be a claim nobody checked —
 * often true, never established. `SCHEMA-DECISIONS.md` D23 already forbids reporting a failure to a
 * patient as though the world had moved on when it might not have.
 *
 * So the retry is not here to make the booking succeed. **It is here to replace a guess with an
 * answer.** The second attempt either books the slot, or hits `23P01` and returns a `SLOT_TAKEN`
 * that has actually been verified. Both outcomes are asserted in
 * `booking-deadlock.integration.spec.ts`; the founder's framing of the same point was that the
 * loser of a deadlock lost a coin toss, not a slot.
 *
 * ## Why not inside `withTenant`
 *
 * A blanket retry would silently re-run every transaction in the API, including ones whose
 * side effects nobody has reasoned about. Whether an operation is safe to repeat is a judgement per
 * operation, so this is applied explicitly at the two call sites that write into the exclusion
 * constraint — `bookAppointment` and `rescheduleAppointment` — and nowhere else.
 */

/** Postgres serialization-failure class: deadlock detected. */
const DEADLOCK_DETECTED = "40P01";

/**
 * Did Postgres kill this transaction to break a deadlock?
 *
 * The shape is measured, not assumed, and is pinned to a real Postgres deadlock by
 * `booking-deadlock.integration.spec.ts` rather than to a hand-built object. Prisma 7 with the `pg`
 * adapter raises `PrismaClientKnownRequestError` with its own code `P2039` and buries the SQLSTATE
 * two levels down — the same burial that made the first version of `isDoubleBookingViolation`
 * wrong.
 */
export function isDeadlock(error: unknown): boolean {
  const cause = (
    error as { meta?: { driverAdapterError?: { cause?: { code?: unknown } } } } | null
  )?.meta?.driverAdapterError?.cause;
  return cause?.code === DEADLOCK_DETECTED;
}

/**
 * Thrown when every attempt deadlocked. Distinguishable so a caller can answer truthfully rather
 * than guessing at what the contention meant.
 */
export class DeadlockExhaustedError extends Error {
  constructor(readonly attempts: number) {
    super(`Deadlocked on all ${String(attempts)} attempts.`);
    this.name = "DeadlockExhaustedError";
  }
}

/**
 * The backoff schedule, in milliseconds, one entry per *retry* — so three attempts in total.
 *
 * **Three attempts, and here is the arithmetic behind the number.** Each deadlock resolution
 * removes exactly one transaction from the cycle, and the survivor commits or fails on its own
 * merits within milliseconds; a retry has to outlast one resolution, not a queue of them. Real
 * contention for a single slot in a clinic is two people, occasionally three — the suite's eight is
 * a stress figure, not a forecast.
 *
 * **The delays below are not the dominant cost, and an earlier version of this note wrongly said
 * the worst case was "roughly 180 ms".** It counted only the backoff. `deadlock_timeout` is `1s` on
 * this cluster — measured with `show deadlock_timeout`, not assumed — and Postgres does not even
 * *look* for a cycle until a transaction has been blocked that long. So a deadlock costs about a
 * second to detect, and the honest worst case for three attempts is **a little over three seconds**
 * before a `CONTENDED` refusal, not milliseconds.
 *
 * That is still the right trade, and it is the founder's to overrule with the real number in front
 * of him: a receptionist waiting two seconds for a correct answer is better served than one waiting
 * one second to be told the system is broken. It is also why the number of attempts stays at three
 * rather than growing — each additional one is another whole second of somebody's morning, and it
 * is only spent in the rare case where a retry deadlocks *again*.
 *
 * **Jittered, and that is not decoration.** A fixed delay re-synchronises the transactions that
 * just collided and marches them into the same collision again; the whole value of a backoff is
 * that the retries stop arriving together. Each delay is multiplied by a factor in [0.5, 1.5).
 */
const RETRY_DELAYS_MS: readonly number[] = [40, 80];

const sleepFor = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export interface RetryOptions {
  /** One entry per retry. Defaults to `RETRY_DELAYS_MS`. */
  delaysMs?: readonly number[];
  /** Injected so a unit test can assert the schedule without spending it. */
  sleep?: (ms: number) => Promise<void>;
  /** Injected for the same reason — the jitter must be observable, not a hidden `Math.random`. */
  random?: () => number;
}

/**
 * Run `operation`, retrying it only when Postgres killed it to break a deadlock.
 *
 * Any other error propagates untouched on the first occurrence, including the `23P01` that means
 * the slot really was taken: that is an answer, not a failure to complete.
 *
 * @throws DeadlockExhaustedError when every attempt deadlocked.
 */
export async function retryOnDeadlock<T>(
  operation: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const delays = options.delaysMs ?? RETRY_DELAYS_MS;
  const sleep = options.sleep ?? sleepFor;
  const random = options.random ?? Math.random;

  for (let attempt = 0; attempt <= delays.length; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!isDeadlock(error)) throw error;
      const delay = delays[attempt];
      if (delay === undefined) throw new DeadlockExhaustedError(delays.length + 1);
      await sleep(Math.round(delay * (0.5 + random())));
    }
  }

  // Unreachable: the loop either returns, rethrows, or throws DeadlockExhaustedError on the last
  // attempt. Stated rather than left to `noImplicitReturns` to make that reasoning explicit.
  throw new DeadlockExhaustedError(delays.length + 1);
}
