import type { TransactionClient } from "../../prisma/with-tenant.ts";

/**
 * Serialise every write that the `no_double_booking` constraint arbitrates, per doctor per day.
 *
 * ## Preventing the deadlock rather than only surviving it
 *
 * `retryOnDeadlock` (see `prisma/deadlock-retry.ts`) makes a deadlocked booking recover, and it
 * stays as the safety net. It does not stop the deadlock happening, and a deadlock costs about a
 * second to detect — `deadlock_timeout` is `1s` on this cluster — before anything can recover from
 * it. The founder's instruction was to remove the collision itself: *"Prevent the deadlock, don't
 * only survive it."*
 *
 * An exclusion constraint is what makes the collision possible in the first place. Unlike a unique
 * index it gets no speculative-insertion treatment: a conflicting inserter writes its index entry
 * and only *then* scans for conflicts, so two transactions can each see the other's entry and each
 * wait on the other's transaction id. Taking a lock **before** the insert means the second
 * transaction waits on a lock rather than on a row, and a lock queue cannot form a cycle when every
 * writer takes the same one.
 *
 * ## The key, and why each part of it is there
 *
 * `(tenantId, doctorId, day)`, hashed to the single `bigint` the advisory-lock functions take.
 *
 * **`tenantId` is not optional.** Advisory locks live in a cluster-wide space that Row-Level
 * Security does not touch — the one place in this API where tenant isolation is not applied for
 * free. Without it, two clinics that happened to share a doctor id would block each other, and a
 * doctor id is a UUID so that would be a bug nobody could reproduce.
 *
 * **The day, not the slot.** A day is the unit real contention arrives in: two receptionists
 * booking "this morning with Dr Hisham" collide on adjacent slots as readily as on the same one,
 * and a slot-keyed lock would let those two deadlock exactly as before. It is coarse — every
 * booking for one doctor on one day now serialises — and that is affordable: the work inside the
 * lock is a handful of millisecond inserts, and a clinic books tens of appointments per doctor-day,
 * not thousands.
 *
 * **`_xact_`, so it is released by commit or rollback and never by hand.** There is no unlock call
 * to forget, no leak on an early return, and a transaction that dies still frees it.
 *
 * ## The invariant that keeps this from becoming the problem it solves
 *
 * **One transaction takes at most one doctor-day lock.** A lock queue cannot form a cycle while
 * that holds, which is the entire reason this works. Two transactions each taking two of these in
 * opposite orders would deadlock on the locks themselves — the same shape as before, moved one
 * level down and harder to see, because a lock wait carries no constraint name to recognise it by.
 *
 * Both callers satisfy it today: a booking locks the day it is booking into, and a reschedule locks
 * the day it is moving *to*. A reschedule does not need the day it is moving *from*: removing the
 * old index entry conflicts with nothing, since an exclusion constraint only checks the value being
 * written.
 *
 * **If a transaction ever needs more than one doctor-day lock, acquire them in sorted key order.**
 * Not "in a sensible order", not "in the order the request lists them" — sorted, on the same key
 * the lock is derived from, every time. A consistent global ordering is what makes a cycle
 * impossible, and any two transactions disagreeing about the order is enough to bring one back.
 * Two callers each picking their own reasonable order is the failure mode, and neither of them
 * looks wrong in review. (SCHEMA-DECISIONS.md D25.)
 *
 * ## `hashtextextended`, and the one thing it costs
 *
 * `pg_advisory_xact_lock` takes a `bigint` (or two `int4`s), so the key has to be hashed. A hash
 * has collisions: two unrelated doctor-days can land on the same lock and serialise needlessly.
 * That is a performance footnote and never a correctness problem — the exclusion constraint remains
 * the arbiter of what may be booked, and this only decides who queues behind whom.
 */

/** `YYYY-MM-DD` in UTC, matching how `scheduled_start` is stored and compared. */
function utcDay(instant: Date): string {
  return instant.toISOString().slice(0, 10);
}

/**
 * Blocks until this transaction owns the lock for that doctor-day, then returns.
 *
 * Must be called **before** the insert or update it protects. Called after, it protects nothing:
 * the index entry is already written and the cycle already possible.
 */
export async function lockDoctorDay(
  tx: TransactionClient,
  key: { tenantId: string; doctorId: string; at: Date },
): Promise<void> {
  const scope = `booking:${key.tenantId}:${key.doctorId}:${utcDay(key.at)}`;
  // Parameterised, not interpolated: `scope` carries ids that arrive from a signed token, and a
  // raw-SQL string built by concatenation is the one shape this project never writes.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${scope}, 0))`;
}
