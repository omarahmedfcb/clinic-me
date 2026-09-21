// Two real deadlock errors, captured verbatim from the reproducer on each Prisma version.
// Not a .spec file: both `driver-error.spec.ts` and `deadlock-retry.spec.ts` read the same copy.

/**
 * **Prisma 7.9.1**, printed from `booking-deadlock.integration.spec.ts` on 2026-09-19.
 *
 * Both spellings are present here — `originalCode` beside `code` — which is why `isDeadlock` could
 * be written against `cause.code` and look correct for as long as this version was pinned.
 */
export const DEADLOCK_7_9_1 = {
  name: "PrismaClientKnownRequestError",
  code: "P2039",
  meta: {
    modelName: "Appointment",
    driverAdapterError: {
      name: "DriverAdapterError",
      cause: {
        originalCode: "40P01",
        originalMessage: "deadlock detected",
        kind: "postgres",
        code: "40P01",
        severity: "ERROR",
        message: "deadlock detected",
        detail:
          "Process 291629 waits for ShareLock on transaction 673208; blocked by process 291628.\nProcess 291628 waits for ShareLock on transaction 673209; blocked by process 291629.",
        hint: "See server log for query details.",
      },
    },
  },
} as const;

/**
 * **Prisma 7.10.0**, printed from the same test on the same machine, minutes apart.
 *
 * Three things moved at once: the Prisma code (`P2039` → `P2034`), the `kind` (`postgres` →
 * `TransactionWriteConflict`), and — the one that broke the retry — `code`, `message`, `severity`,
 * `detail` and `hint` are simply gone. Only the `original*` pair survives.
 */
export const DEADLOCK_7_10_0 = {
  name: "PrismaClientKnownRequestError",
  code: "P2034",
  meta: {
    modelName: "Appointment",
    driverAdapterError: {
      name: "DriverAdapterError",
      cause: {
        originalCode: "40P01",
        originalMessage: "deadlock detected",
        kind: "TransactionWriteConflict",
      },
    },
  },
} as const;

/**
 * An exclusion violation — the slot really was taken. Not a deadlock, and never retried.
 *
 * Captured on **7.9.1**, and the 7.10.0 capture below shows this one did *not* change: an ordinary
 * constraint violation keeps the full Postgres shape on both versions. Only the transaction-conflict
 * error was reduced, which is why the concurrency suite stayed green while the deadlock suite broke.
 */
export const SLOT_TAKEN_7_9_1 = {
  name: "PrismaClientKnownRequestError",
  code: "P2039",
  meta: {
    modelName: "Appointment",
    driverAdapterError: {
      name: "DriverAdapterError",
      cause: {
        originalCode: "23P01",
        originalMessage: 'conflicting key value violates exclusion constraint "no_double_booking"',
        kind: "postgres",
        code: "23P01",
        severity: "ERROR",
        message: 'conflicting key value violates exclusion constraint "no_double_booking"',
        detail: "Key conflicts with existing key.",
      },
    },
  },
} as const;
