// The bot's rate limits, keyed on the credential. docs/WHATSAPP-BOT-CONTRACT.md §5.

import type { ExecutionContext } from "@nestjs/common";
import type { ThrottlerOptions } from "@nestjs/throttler";

/**
 * **Keyed on the credential, never the IP.**
 *
 * A bot runs from a handful of addresses, often shared with other tenants of the same host. A
 * per-IP limit is then either uselessly wide or takes one clinic offline because a different
 * clinic's bot is noisy next door. The credential is the thing whose behaviour we are limiting, so
 * it is the thing counted — and a clinic's own limit cannot be exhausted by anybody else.
 *
 * The limits themselves are the contract's opening numbers, to be tuned against the first weeks of
 * real traffic rather than guessed more precisely now.
 */
export const BOT_CREDENTIAL_THROTTLER = "bot-credential";
export const BOT_WRITE_THROTTLER = "bot-write";
export const BOT_CREATE_PATIENT_THROTTLER = "bot-create-patient";

const WINDOW_MS = 60_000;
const HOUR_MS = 60 * 60_000;

/** The authenticated bot's membership, or the credential id it is presenting, or the address. */
function credentialTracker(request: Record<string, unknown>): string {
  const claims = request["authClaims"] as { membershipId?: unknown } | undefined;
  if (typeof claims?.membershipId === "string") return `bot:${claims.membershipId}`;

  const body = request["body"] as { credentialId?: unknown } | undefined;
  if (typeof body?.credentialId === "string") return `credential:${body.credentialId}`;

  return `ip:${String(request["ip"] ?? "unknown")}`;
}

export const BOT_THROTTLERS: ThrottlerOptions[] = [
  {
    name: BOT_CREDENTIAL_THROTTLER,
    ttl: WINDOW_MS,
    limit: 60,
    getTracker: (request: Record<string, unknown>, _context: ExecutionContext) => credentialTracker(request),
  },
  {
    // Booking-changing calls: book, reschedule, cancel. Ten an hour per credential is generous for
    // a conversation and tight for a loop.
    name: BOT_WRITE_THROTTLER,
    ttl: HOUR_MS,
    limit: 60,
    getTracker: (request: Record<string, unknown>, _context: ExecutionContext) => credentialTracker(request),
  },
  {
    // A bot that can create patients can fill a clinic's book with them.
    name: BOT_CREATE_PATIENT_THROTTLER,
    ttl: HOUR_MS,
    limit: 10,
    getTracker: (request: Record<string, unknown>, _context: ExecutionContext) => credentialTracker(request),
  },
];
