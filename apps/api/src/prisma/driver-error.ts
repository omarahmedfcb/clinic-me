// The SQLSTATE Prisma buries inside a driver-adapter error, read once for every classifier.
// 7.9.1 supplies `code` and `originalCode`; 7.10.0 dropped `code`, so both spellings are accepted.

/** What a classifier needs from a Postgres error, whatever Prisma called it this version. */
export interface DriverCause {
  code?: string;
  message?: string;
}

/**
 * The Postgres error underneath a `PrismaClientKnownRequestError`, or an empty result.
 *
 * **Both spellings, because the shape has already moved once and will move again.** Prisma 7.9.1
 * raised `P2039` with the SQLSTATE at `cause.code` *and* at `cause.originalCode`; 7.10.0 raises
 * `P2034` for a deadlock and keeps only `originalCode`. `isDeadlock` read `cause.code`, so under
 * 7.10.0 it returned `false` for a real deadlock and the booking retry silently stopped running —
 * caught by `booking-deadlock.integration.spec.ts`, which raises the error rather than building it.
 *
 * Reading the burial path in one place is the point: a third classifier written later cannot pick
 * the wrong spelling, because it does not see the spelling at all.
 */
export function driverCause(error: unknown): DriverCause {
  const cause = (
    error as {
      meta?: {
        driverAdapterError?: {
          cause?: { code?: unknown; originalCode?: unknown; message?: unknown; originalMessage?: unknown };
        };
      };
    } | null
  )?.meta?.driverAdapterError?.cause;

  if (cause === undefined || cause === null) return {};

  return {
    code: firstString(cause.originalCode, cause.code),
    message: firstString(cause.originalMessage, cause.message),
  };
}

/** `originalX` first: it is the spelling both measured versions carry. */
function firstString(...candidates: unknown[]): string | undefined {
  for (const candidate of candidates) {
    if (typeof candidate === "string") return candidate;
  }
  return undefined;
}
