import { randomUUID } from "node:crypto";
import { isDeadlock, retryOnDeadlock } from "../../src/prisma/deadlock-retry.ts";
import { driverCause } from "../../src/prisma/driver-error.ts";
import { lockDoctorDay } from "../../src/modules/appointments/slot-day-lock.ts";
import { prisma } from "../../src/prisma/client.ts";
import { injected } from "../../src/prisma/injected.ts";
import { withTenant } from "../../src/prisma/with-tenant.ts";
import { actorFor, seedClinic, teardownClinic, type ClinicFixture } from "./fixtures.ts";

/**
 * A real Postgres deadlock on `no_double_booking`, forced deterministically.
 *
 * ## Why this file exists rather than a re-run
 *
 * `booking-concurrency.integration.spec.ts` had failed about one run in ten since 2026-08-29 with
 * no error detail, was instrumented on 2026-09-02 to report its rejections as data, and named its
 * own cause on 2026-09-06: `40P01`, deadlock detected. That is a *sighting*, and a sighting cannot
 * tell you a fix worked — it can only stop appearing, which is what an intermittent failure does on
 * its own. The founder's instruction was to rebuild a reproducer before writing anything: *"it's
 * the only way to know the fix works rather than that the symptom stopped appearing."*
 *
 * ## How the deadlock is forced
 *
 * Two transactions take **two different slots in opposite order**, with a barrier so that both have
 * inserted their first row before either attempts its second. A then waits on B's uncommitted row
 * and B on A's, which is a cycle, and Postgres kills one.
 *
 * That is not the interleaving production hits — there, eight callers contend for *one* slot and
 * two of them happen to write their index entries before either scans. It is the same **error**,
 * from the same **constraint**, through the same **transaction helper**, arriving at the same
 * `catch`. What a fix has to handle is the error, and this produces it on demand rather than one
 * run in ten: the barrier removes the race, and it was 5 for 5 before any fix existed.
 *
 * The constraint can deadlock at all because it is an exclusion constraint rather than a unique
 * index, so it gets no speculative-insertion treatment: a conflicting inserter writes its index
 * entry and only then scans for conflicts.
 */
describe("the exclusion constraint can deadlock, and the retry survives it", () => {
  let clinic: ClinicFixture;

  /** Far enough out that nothing the fixture seeds can overlap these two slots. */
  const SLOT_A = new Date("2026-10-01T09:00:00Z");
  const SLOT_B = new Date("2026-10-01T10:00:00Z");
  const HALF_HOUR = 30 * 60_000;

  beforeAll(async () => {
    clinic = await seedClinic();
  });

  afterAll(async () => {
    await teardownClinic(clinic);
    await prisma.$disconnect();
  });

  /** Ids each session attempted, so a rollback can be shown to have removed all of them. */
  let attempted: Record<string, string[]> = {};

  // No return annotation on purpose: `injected()` needs the literal object type to narrow Prisma's
  // create input, and widening this to `Record<string, unknown>` makes it reject the whole thing.
  const row = (start: Date, label: string) => {
    const id = randomUUID();
    (attempted[label] ??= []).push(id);
    return {
      id,
      patientId: clinic.patientId,
      doctorId: clinic.doctorId,
      serviceId: clinic.serviceId,
      scheduledStart: start,
      scheduledEnd: new Date(start.getTime() + HALF_HOUR),
      status: "BOOKED" as const,
      source: "RECEPTION" as const,
      createdBy: clinic.userId,
      updatedBy: clinic.userId,
    };
  };

  /** Clears both slots so each test starts from the same state, whichever transaction won. */
  const clearSlots = async (): Promise<void> => {
    attempted = {};
    await withTenant(clinic.tenantId, actorFor(clinic.userId), (tx) =>
      tx.appointment.deleteMany({ where: { scheduledStart: { in: [SLOT_A, SLOT_B] } } }),
    );
  };

  /** Thrown deliberately to undo a survivor's work. Not a deadlock, so it is never retried. */
  const ROLLBACK = new Error("deliberate rollback");

  /**
   * Two transactions, crossed. Returns what each one settled to.
   *
   * `wrap` is where the fix goes in: with the identity function this is the unfixed behaviour, and
   * with `retryOnDeadlock` it is the fixed one. The same experiment run both ways is the contrast
   * this project asks for, rather than two differently-shaped tests that cannot be compared.
   *
   * `rollBackFirstAttempt` makes whichever session survives the deadlock undo itself, so the
   * victim's retry finds the slots free. Without it the survivor commits both slots and the retry
   * correctly answers SLOT_TAKEN instead — both outcomes are truthful and both are asserted below.
   */
  const crossedInserts = async (
    wrap: <T>(operation: () => Promise<T>) => Promise<T>,
    rollBackFirstAttempt = false,
    takeLock = false,
  ): Promise<PromiseSettledResult<string>[]> => {
    let releaseA = (): void => {};
    let releaseB = (): void => {};
    const aHasItsFirstRow = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    const bHasItsFirstRow = new Promise<void>((resolve) => {
      releaseB = resolve;
    });
    const attempts: Record<string, number> = {};

    const session = (
      first: Date,
      second: Date,
      signal: () => void,
      waitFor: Promise<void>,
      label: string,
    ): Promise<string> =>
      wrap(() => {
        attempts[label] = (attempts[label] ?? 0) + 1;
        const isFirstAttempt = attempts[label] === 1;
        return withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) => {
          // Mirrors what `bookAppointment` does: the lock before the write it protects. Both slots
          // fall on the same UTC day for the same doctor, so this is one lock and the two sessions
          // queue on it instead of on each other's index entries.
          if (takeLock) {
            await lockDoctorDay(tx, {
              tenantId: clinic.tenantId,
              doctorId: clinic.doctorId,
              at: first,
            });
          }
          await tx.appointment.create({ data: injected(row(first, label)) });
          signal();
          // The barrier, with a deadline. Without a barrier one transaction simply finishes first
          // and there is no cycle, which is why re-running the concurrency suite could never be
          // relied on to make one. Without the *deadline* the locked variant would hang rather than
          // pass: the second session is queued on the advisory lock and can never reach its signal,
          // so the first would wait for a message that is not coming. Racing the signal against a
          // short timer is what lets one piece of apparatus run both ways.
          await Promise.race([waitFor, new Promise<void>((resolve) => setTimeout(resolve, 300))]);
          await tx.appointment.create({ data: injected(row(second, label)) });
          if (rollBackFirstAttempt && isFirstAttempt) throw ROLLBACK;
          return label;
        });
      });

    return Promise.allSettled([
      session(SLOT_A, SLOT_B, releaseA, bHasItsFirstRow, "A"),
      session(SLOT_B, SLOT_A, releaseB, aHasItsFirstRow, "B"),
    ]);
  };

  const storedSlots = (): Promise<{ id: string }[]> =>
    withTenant(clinic.tenantId, actorFor(clinic.userId), (tx) =>
      tx.appointment.findMany({
        where: { scheduledStart: { in: [SLOT_A, SLOT_B] } },
        select: { id: true },
      }),
    );

  test("unretried, one transaction is killed with 40P01 that isDeadlock recognises", async () => {
    await clearSlots();
    const settled = await crossedInserts((operation) => operation());

    const rejected = settled.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );

    // Exactly one victim: Postgres breaks the cycle by killing one member, not both.
    expect(rejected).toHaveLength(1);

    // The classifier is pinned to this error rather than to a hand-written object. If Prisma moves
    // the SQLSTATE, `isDeadlock` starts returning false, every deadlock silently stops being
    // retried, and this is the test that says so — the guarantee `isDoubleBookingViolation` did not
    // have when it was first written against the shape the docs describe rather than the one raised.
    //
    // It said so, on 2026-09-19: Prisma 7.10.0 renamed `cause.code` to `cause.originalCode` and
    // this line went red while every unit spec stayed green. Read through `driverCause` now, so the
    // assertion follows the classifier rather than one version's field name.
    expect(isDeadlock(rejected[0]?.reason)).toBe(true);
    expect(driverCause(rejected[0]?.reason).code).toBe("40P01");
  }, 30_000);

  /**
   * **The fact the retry's safety rests on**, and the one `PHASE-2.md`'s "do not add a retry" rule
   * was written without: a deadlock abort is *total*. Not one of the victim's rows survives, so a
   * repeat cannot append to half-finished work and cannot double-book.
   *
   * It also settles what the victim may be told. The victim's writes are gone but the survivor's
   * are committed, so **nothing about the error says whether the slot is free** — answering "that
   * time was just taken" would be a claim nobody checked. Sometimes true, never established. The
   * retry is what replaces the guess with an answer.
   */
  test("a deadlock abort removes every row the victim wrote, and nothing else", async () => {
    await clearSlots();
    const settled = await crossedInserts((operation) => operation());

    const victimLabel = settled.findIndex((result) => result.status === "rejected") === 0 ? "A" : "B";
    const survivorLabel = victimLabel === "A" ? "B" : "A";

    const stored = (await storedSlots()).map((appointment) => appointment.id);
    expect(stored.sort()).toEqual([...(attempted[survivorLabel] ?? [])].sort());
    for (const id of attempted[victimLabel] ?? []) expect(stored).not.toContain(id);
  }, 30_000);

  /**
   * **The assertion the fix exists for.** Same experiment, same barrier, same constraint; the only
   * difference is the wrapper. Unretried, the first test proves one side rejects with 40P01. Here
   * the survivor undoes itself, so the victim's retry meets free slots and completes.
   */
  test("retried, a deadlock victim runs again and succeeds when the slots are free", async () => {
    await clearSlots();
    const settled = await crossedInserts((operation) => retryOnDeadlock(operation), true);

    // The survivor rejects with ROLLBACK by construction — a non-deadlock error, which
    // `retryOnDeadlock` passed straight through. That is the "never retry anything else" rule
    // holding against a real transaction rather than only against the unit spec's stub.
    const rejections = settled.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    expect(rejections.map((rejection) => rejection.reason)).toEqual([ROLLBACK]);

    // And the victim — the one Postgres killed — came back and finished.
    expect(settled.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(await storedSlots()).toHaveLength(2);
  }, 30_000);

  /**
   * The other truthful outcome, and the commoner one in production. When the survivor keeps its
   * rows, the retry runs into the committed conflict and raises `23P01` — which `bookAppointment`
   * turns into SLOT_TAKEN. That answer is now **established by a second attempt** rather than
   * assumed from a deadlock, which is the whole of what the retry buys.
   */
  test("retried into a slot that really is taken, the answer is 23P01 rather than 40P01", async () => {
    await clearSlots();
    const settled = await crossedInserts((operation) => retryOnDeadlock(operation));

    const rejections = settled.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    expect(rejections).toHaveLength(1);

    // No deadlock reaches the caller any more: the retry converted it into a real conflict.
    expect(isDeadlock(rejections[0]?.reason)).toBe(false);
    expect(driverCause(rejections[0]?.reason).code).toBe("23P01");
  }, 30_000);

  /**
   * **The prevention, measured against the same apparatus that demonstrates the disease.**
   *
   * Ruled on 2026-09-06: *"Prevent the deadlock, don't only survive it."* `retryOnDeadlock` recovers
   * from a deadlock but cannot stop one, and stopping one is worth roughly a second every time it
   * happens, because Postgres does not look for a cycle until `deadlock_timeout` has elapsed.
   *
   * The only difference between this test and the first one in this file is `takeLock`. Everything
   * else -- the crossed order, the barrier, the constraint, the transaction helper -- is identical,
   * which is what makes the comparison worth anything.
   */
  test("with the doctor-day lock taken, the crossed inserts cannot deadlock", async () => {
    await clearSlots();
    const settled = await crossedInserts((operation) => operation(), false, true);

    const rejections = settled.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );

    // **No deadlock.** This is the assertion the lock exists for.
    expect(rejections.filter((rejection) => isDeadlock(rejection.reason))).toEqual([]);

    // One session still loses, and loses for the right reason: it queued, found the slots taken by
    // the session ahead of it, and got the exclusion constraint's answer rather than a coin toss.
    // Asserting this too is what stops the lock from passing by serialising everything into
    // nothing -- a lock that made both sessions fail would satisfy "no deadlock" as well.
    expect(settled.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(rejections).toHaveLength(1);
    expect(driverCause(rejections[0]?.reason).code).toBe("23P01");

    expect(await storedSlots()).toHaveLength(2);
  }, 30_000);
});
