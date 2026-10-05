// Rate limiting the public signup. Creating a clinic is the most expensive thing an anonymous
// caller can ask this API to do (Argon2, a Meta round trip, a tenant), so the address gets few
// attempts. The limit is per address because there is no account yet to key on.

import type { ExecutionContext } from "@nestjs/common";
import type { ThrottlerOptions } from "@nestjs/throttler";

export const WHATSAPP_SIGNUP_THROTTLER = "whatsapp-signup";

export const WHATSAPP_SIGNUP_LIMIT = 6;
export const WHATSAPP_SIGNUP_WINDOW_MS = 60 * 60_000;

export const WHATSAPP_SIGNUP_THROTTLERS: ThrottlerOptions[] = [
  {
    name: WHATSAPP_SIGNUP_THROTTLER,
    ttl: WHATSAPP_SIGNUP_WINDOW_MS,
    limit: WHATSAPP_SIGNUP_LIMIT,
    getTracker: (request: Record<string, unknown>, _context: ExecutionContext) =>
      `ip:${String(request["ip"] ?? "unknown")}`,
  },
];
