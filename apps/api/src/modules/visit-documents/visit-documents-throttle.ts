// Rate limiting the public documents link. There is no login, so the address is the only identity there
// is -- the same reasoning as the web chat's limiter (webchat-throttle.ts).

import type { ExecutionContext } from "@nestjs/common";
import type { ThrottlerOptions } from "@nestjs/throttler";

export const DOCUMENTS_READ_THROTTLER = "documents-read";
export const DOCUMENTS_PDF_THROTTLER = "documents-pdf";

const WINDOW_MS = 60_000;

function ipTracker(request: Record<string, unknown>): string {
  return `ip:${String(request["ip"] ?? "unknown")}`;
}

/**
 * Two buckets, because the two routes cost very different amounts. A page view is a database read; a
 * PDF is a browser launch on a small server, which is the one thing here worth protecting from a loop.
 * Tokens are 256 bits, so guessing is hopeless regardless; this limit exists for load, not for secrecy.
 */
export const VISIT_DOCUMENTS_THROTTLERS: ThrottlerOptions[] = [
  {
    name: DOCUMENTS_READ_THROTTLER,
    ttl: WINDOW_MS,
    limit: 60,
    getTracker: (request: Record<string, unknown>, _context: ExecutionContext) => ipTracker(request),
  },
  {
    name: DOCUMENTS_PDF_THROTTLER,
    ttl: WINDOW_MS,
    limit: 10,
    getTracker: (request: Record<string, unknown>, _context: ExecutionContext) => ipTracker(request),
  },
];
