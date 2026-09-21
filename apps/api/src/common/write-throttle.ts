// Rate limits for the write routes a script could abuse — intake, payments, uploads.
// Pilot-readiness 4b. Keyed on the membership, never on the address.

import type { ExecutionContext } from "@nestjs/common";
import type { ThrottlerOptions } from "@nestjs/throttler";

/**
 * **Clinic-safe keys: the membership, not the IP.**
 *
 * An Egyptian clinic sits behind one NAT, so reception, the doctors and the admin share a public
 * address. A per-IP write limit takes the whole practice offline during a clinic day the first time
 * one person is busy — the limit doing exactly what it was configured to do, and still a fault
 * report. `auth-throttle.ts` already carries that argument for login; this is the same argument for
 * the routes a script would actually use.
 *
 * The membership is the right unit because it is what a stolen token authenticates as: a runaway
 * script or a leaked credential is contained to one account, and the desk beside it keeps working.
 */
export const INTAKE_THROTTLER = "intake-write";
export const PAYMENTS_THROTTLER = "payments-write";
export const UPLOAD_THROTTLER = "upload-write";

const WINDOW_MS = 60_000;

/**
 * Ceilings, not budgets. A receptionist registering patients from a paper list is fast; a script is
 * faster by two orders of magnitude, and these sit between the two.
 */
export const WRITE_THROTTLE_LIMITS = {
  windowMs: WINDOW_MS,
  /** Registering and editing patients. A busy desk does perhaps ten a minute. */
  intake: 60,
  /** Taking money and issuing credit. Also the route where a duplicate is most expensive. */
  payments: 60,
  /** Uploads are bytes as well as rows, and one loop can fill a disk. */
  upload: 20,
} as const;

/** The claims an authenticated request carries. Read, never trusted from a body or a header. */
interface ThrottledRequest {
  authClaims?: { membershipId?: unknown; tenantId?: unknown };
  ip?: unknown;
}

/**
 * The membership, then the clinic, then the address.
 *
 * The fallbacks exist so the key is never empty, not because they are good keys: an unauthenticated
 * request cannot reach any of these routes — `AuthGuard` runs first — so in practice the membership
 * is always there, and a fallback that fired would mean the guard order had changed.
 */
export function writeTracker(request: ThrottledRequest): string {
  const claims = request.authClaims;
  if (typeof claims?.membershipId === "string") return `membership:${claims.membershipId}`;
  if (typeof claims?.tenantId === "string") return `tenant:${claims.tenantId}`;
  return `ip:${String(request.ip ?? "unknown")}`;
}

const tracker = (request: Record<string, unknown>, _context: ExecutionContext): string =>
  writeTracker(request as ThrottledRequest);

export const WRITE_THROTTLERS: ThrottlerOptions[] = [
  { name: INTAKE_THROTTLER, ttl: WINDOW_MS, limit: WRITE_THROTTLE_LIMITS.intake, getTracker: tracker },
  { name: PAYMENTS_THROTTLER, ttl: WINDOW_MS, limit: WRITE_THROTTLE_LIMITS.payments, getTracker: tracker },
  { name: UPLOAD_THROTTLER, ttl: WINDOW_MS, limit: WRITE_THROTTLE_LIMITS.upload, getTracker: tracker },
];

