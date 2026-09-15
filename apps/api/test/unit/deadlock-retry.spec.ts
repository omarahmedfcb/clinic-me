import {
  DeadlockExhaustedError,
  isDeadlock,
  retryOnDeadlock,
} from "../../src/prisma/deadlock-retry.ts";

/**
 * The retry loop's arithmetic. The *classifier* is pinned to a real Postgres deadlock in
 * `booking-deadlock.integration.spec.ts` — a hand-built error object can only prove that this file
 * agrees with itself, which is the trap the first version of `isDoubleBookingViolation` fell into
 * by asserting the shape the Prisma docs describe rather than the one the adapter raises.
 *
 * What is asserted here is what a database cannot conveniently be made to demonstrate: that the
 * loop retries the right number of times, waits the right amounts, gives up rather than looping,
 * and — the one that matters most — does not retry anything that is not a deadlock.
 */

/** The shape Prisma 7 with the `pg` adapter actually raises, copied from a measured one. */
const deadlock = (): unknown => ({
  name: "PrismaClientKnownRequestError",
  code: "P2039",
  meta: {
    modelName: "Appointment",
    driverAdapterError: {
      name: "DriverAdapterError",
      cause: { code: "40P01", message: "deadlock detected", severity: "ERROR" },
    },
  },
});

/** The slot really was taken. An answer, and it must reach the caller on the first occurrence. */
const slotTaken = (): unknown => ({
  code: "P2039",
  meta: {
    driverAdapterError: {
      cause: {
        code: "23P01",
        message: 'conflicting key value violates exclusion constraint "no_double_booking"',
      },
    },
  },
});

describe("isDeadlock recognises 40P01 and nothing else", () => {
  test("a deadlock is a deadlock", () => {
    expect(isDeadlock(deadlock())).toBe(true);
  });

  test("an exclusion violation is not", () => {
    // The important half. If this were true, every lost race would be retried three times and then
    // reported as CONTENDED -- turning the ordinary, correct SLOT_TAKEN answer into a confusing one
    // and tripling the load of a busy morning.
    expect(isDeadlock(slotTaken())).toBe(false);
  });

  test("neither is anything else, including the shapes that look close", () => {
    // `code` at the top level is where the Prisma docs say to look, and where it is not.
    expect(isDeadlock({ code: "40P01" })).toBe(false);
    expect(isDeadlock({ meta: { driverAdapterError: { cause: { code: "40001" } } } })).toBe(false);
    expect(isDeadlock(new Error("deadlock detected"))).toBe(false);
    expect(isDeadlock(null)).toBe(false);
    expect(isDeadlock(undefined)).toBe(false);
  });
});

describe("retryOnDeadlock", () => {
  const noSleep = { sleep: async (): Promise<void> => {}, random: (): number => 0.5 };

  test("a call that succeeds first time is called once and never slept on", async () => {
    let calls = 0;
    const slept: number[] = [];
    const value = await retryOnDeadlock(
      () => {
        calls += 1;
        return Promise.resolve("booked");
      },
      {
        ...noSleep,
        sleep: async (ms) => {
          slept.push(ms);
        },
      },
    );
    expect({ value, calls, slept }).toEqual({ value: "booked", calls: 1, slept: [] });
  });

  test("a deadlock on the first attempt is retried and the second attempt's value is returned", async () => {
    let calls = 0;
    const value = await retryOnDeadlock(() => {
      calls += 1;
      return calls === 1 ? Promise.reject(deadlock()) : Promise.resolve("booked");
    }, noSleep);
    expect({ value, calls }).toEqual({ value: "booked", calls: 2 });
  });

  test("three attempts in total, then DeadlockExhaustedError rather than another loop", async () => {
    let calls = 0;
    const slept: number[] = [];
    const attempt = retryOnDeadlock(
      () => {
        calls += 1;
        return Promise.reject(deadlock());
      },
      {
        random: () => 0.5,
        sleep: async (ms) => {
          slept.push(ms);
        },
      },
    );

    await expect(attempt).rejects.toBeInstanceOf(DeadlockExhaustedError);
    // Two waits, not three: the last attempt fails and reports rather than sleeping on nothing.
    // At the midpoint of the jitter the schedule is exactly the base delays.
    expect({ calls, slept }).toEqual({ calls: 3, slept: [40, 80] });
  });

  test("the backoff is jittered, so the transactions that just collided do not re-collide", async () => {
    // A fixed delay marches the retries back into the same instant. Asserted at both ends of the
    // range because a jitter that is always the same number is not a jitter, and nothing else in
    // the suite would notice.
    const runWith = async (random: () => number): Promise<number[]> => {
      const slept: number[] = [];
      await retryOnDeadlock(() => Promise.reject(deadlock()), {
        random,
        sleep: async (ms) => {
          slept.push(ms);
        },
      }).catch(() => undefined);
      return slept;
    };

    expect(await runWith(() => 0)).toEqual([20, 40]);
    expect(await runWith(() => 0.999)).toEqual([60, 120]);
  });

  test("anything that is not a deadlock propagates on the first attempt, unretried", async () => {
    let calls = 0;
    const taken = slotTaken();
    await expect(
      retryOnDeadlock(() => {
        calls += 1;
        return Promise.reject(taken);
      }, noSleep),
    ).rejects.toBe(taken);
    expect(calls).toBe(1);
  });

  test("the number of attempts is the schedule's length plus one, whatever the schedule", async () => {
    // Stated as a relationship rather than as the constant 3, so that changing the schedule cannot
    // leave a test asserting an attempt count the code no longer has.
    for (const delaysMs of [[], [10], [10, 20], [10, 20, 30]]) {
      let calls = 0;
      await retryOnDeadlock(() => {
        calls += 1;
        return Promise.reject(deadlock());
      }, { ...noSleep, delaysMs }).catch(() => undefined);
      expect(calls).toBe(delaysMs.length + 1);
    }
  });
});
