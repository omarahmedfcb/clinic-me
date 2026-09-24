// Rate limiting the public web chat. There is no login and so no credential or membership to key
// on -- the address is the only identity there is, same as the unauthenticated auth-ip bucket.

import type { ExecutionContext } from "@nestjs/common";
import type { ThrottlerOptions } from "@nestjs/throttler";

export const WEBCHAT_MESSAGE_THROTTLER = "webchat-message";

const WINDOW_MS = 60_000;

/**
 * Thirty messages a minute per address. A tool-calling round trip is still one message from the
 * patient's side, so this is generous for a real conversation and tight for a script driving
 * Groq spend or the booking endpoints through this one open door.
 */
const LIMIT = 30;

function ipTracker(request: Record<string, unknown>): string {
  return `ip:${String(request["ip"] ?? "unknown")}`;
}

export const WEBCHAT_THROTTLERS: ThrottlerOptions[] = [
  {
    name: WEBCHAT_MESSAGE_THROTTLER,
    ttl: WINDOW_MS,
    limit: LIMIT,
    getTracker: (request: Record<string, unknown>, _context: ExecutionContext) => ipTracker(request),
  },
];
