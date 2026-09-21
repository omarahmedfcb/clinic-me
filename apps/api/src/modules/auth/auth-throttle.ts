import type { ExecutionContext } from "@nestjs/common";
import type { ThrottlerOptions } from "@nestjs/throttler";
import { toLatinDigits } from "./phone.ts";

/**
 * Rate limiting for the auth endpoints (PHASE-1 §1).
 *
 * ## Two independent buckets, not one composite key
 *
 * Limiting by IP alone and limiting by identifier alone each fail, in opposite directions, and a
 * single composite key fails in both at once:
 *
 * - **IP only.** An Egyptian clinic sits behind one NAT. Reception, the doctors and the admin all
 *   share a public address, so a handful of mistyped passwords at the front desk locks out the
 *   entire practice — during a clinic day, with patients waiting. The limit would be doing exactly
 *   what it was configured to do and would still be a fault report.
 * - **Identifier only.** Nothing stops an attacker spreading a spray across many accounts from one
 *   machine, since each identifier gets its own untouched bucket.
 * - **Composite `(ip, identifier)`.** Both problems return: rotating IPs hands the attacker a fresh
 *   bucket for the identifier being attacked, and a busy NAT still collides on the reception desk's
 *   own credentials.
 *
 * So there are two named throttlers, each counting independently. A request is refused if *either*
 * is exhausted, which is the behaviour that survives both a shared NAT and a rotating attacker.
 *
 * ## The identifier is normalised before it becomes a key
 *
 * `٠١٠٠١٢٣٤٥٦٧` and `01001234567` are the same account, so they must be the same bucket. Without
 * folding the digits first, an attacker gets a fresh allowance per notation — and there are at
 * least three notations for every Egyptian mobile number.
 *
 * ## The identifier bucket is not an oracle
 *
 * Being rate-limited is the same 429 whether or not the account exists, because the key is derived
 * from what the caller sent rather than from anything looked up. An attacker learns that *they*
 * have sent too many requests, which they already knew.
 */

/** Fifteen minutes. Long enough to blunt a spray, short enough that a locked-out receptionist waits. */
const WINDOW_MS = 15 * 60 * 1000;

/**
 * Ten failures per identifier per window. A human who has forgotten which of two passwords they
 * used does not reach ten; an online guessing attack passes it almost immediately.
 */
const IDENTIFIER_LIMIT = 10;

/**
 * Sixty per IP per window. Deliberately much higher than the per-identifier limit: this bucket is
 * shared by an entire clinic behind one NAT, so it is a backstop against one host hammering many
 * accounts, not the primary control. The per-identifier limit is the primary control.
 */
const IP_LIMIT = 60;

export const PASSWORD_THROTTLER = "password-user";
export const IDENTIFIER_THROTTLER = "auth-identifier";
export const IP_THROTTLER = "auth-ip";

/** Lower than the login bucket: a signed-in user knows their own password and does not guess at it. */
const PASSWORD_LIMIT = 5;

/** The body shape the identifier tracker reads. Duplicated rather than imported to avoid a cycle. */
interface MaybeLoginBody {
  identifier?: unknown;
}

/**
 * The key for the per-identifier bucket.
 *
 * Falls back to the IP when there is no identifier in the body — `/auth/refresh` and `/auth/logout`
 * present a cookie, not a phone number. Falling back to a constant would put every such request
 * into one global bucket and let one client deny the endpoint to everyone.
 */
export function identifierTracker(request: Record<string, unknown>): string {
  const body = (request["body"] ?? {}) as MaybeLoginBody;
  const identifier = typeof body.identifier === "string" ? body.identifier : "";
  const normalised = toLatinDigits(identifier).trim().toLowerCase();
  if (normalised.length === 0) return `ip:${String(request["ip"] ?? "unknown")}`;
  return `id:${normalised}`;
}

/** The key for the per-IP bucket. `req.ip` is only the real client because of `trust proxy`. */
export function ipTracker(request: Record<string, unknown>): string {
  return `ip:${String(request["ip"] ?? "unknown")}`;
}

/**
 * The key for `POST /auth/password`, which verifies `currentPassword` and so is guessable.
 *
 * Keyed on the authenticated user, **never the address**: a clinic sits behind one public IP, so an
 * address bucket would let one member of staff exhaust the limit and lock the reception desk out of
 * changing passwords. Falls back to the IP only when no claims are present, which the guard order
 * makes unreachable — `AuthGuard` runs first — and which must still not key everyone together.
 */
export function passwordUserTracker(request: Record<string, unknown>): string {
  const claims = request["authClaims"] as { sub?: unknown } | undefined;
  const sub = typeof claims?.sub === "string" ? claims.sub : "";
  return sub.length > 0 ? `user:${sub}` : `ip:${String(request["ip"] ?? "unknown")}`;
}

export const AUTH_THROTTLERS: ThrottlerOptions[] = [
  {
    name: IDENTIFIER_THROTTLER,
    ttl: WINDOW_MS,
    limit: IDENTIFIER_LIMIT,
    getTracker: (request: Record<string, unknown>, _context: ExecutionContext) => identifierTracker(request),
  },
  {
    name: IP_THROTTLER,
    ttl: WINDOW_MS,
    limit: IP_LIMIT,
    getTracker: (request: Record<string, unknown>, _context: ExecutionContext) => ipTracker(request),
  },
  {
    name: PASSWORD_THROTTLER,
    ttl: WINDOW_MS,
    limit: PASSWORD_LIMIT,
    getTracker: (request: Record<string, unknown>, _context: ExecutionContext) => passwordUserTracker(request),
  },
];

export const AUTH_THROTTLE_LIMITS = {
  windowMs: WINDOW_MS,
  identifier: IDENTIFIER_LIMIT,
  ip: IP_LIMIT,
  password: PASSWORD_LIMIT,
} as const;

/** Named so a route can skip the buckets that are not about it, rather than inherit all three. */
export const CREDENTIAL_THROTTLERS = { "auth-identifier": true, "auth-ip": true } as const;
export const SKIP_PASSWORD_THROTTLER = { [PASSWORD_THROTTLER]: true } as const;
