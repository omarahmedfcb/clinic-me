// One pass of the outbox: queue tomorrow's reminders, then deliver everything owed. Run from cron,
// every minute — docs/SERVER-SETUP.md. Safe to overlap: the database owns both idempotency rules.

import { prisma } from "../src/prisma/client.ts";
import { dispatchDueDeliveries, sweepReminders } from "../src/modules/bot/webhook-dispatch.ts";

/** A delivery that hangs would hold the pass open; the bot answers on receipt, so ten seconds is generous. */
const TIMEOUT_MS = 10_000;

async function post(
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
): Promise<{ status: number }> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  return { status: response.status };
}

async function main(): Promise<void> {
  const now = new Date();
  const queued = await sweepReminders(now);
  const outcomes = await dispatchDueDeliveries(now, { fetch: post });

  const tally: Record<string, number> = {};
  for (const outcome of outcomes) {
    const key = outcome.result === "skipped" ? `skipped:${outcome.reason}` : outcome.result;
    tally[key] = (tally[key] ?? 0) + 1;
  }

  // One line a person can read in a log, naming what happened rather than that it ran.
  console.log(
    `webhook-dispatch ${now.toISOString()} reminders_queued=${queued} ` +
      Object.entries(tally)
        .map(([key, count]) => `${key}=${count}`)
        .join(" "),
  );
}

/**
 * One pass, or a pass every `WEBHOOK_DISPATCH_INTERVAL_MS`.
 *
 * Cron runs the single pass on a server. The loop is for the sandbox, where there is no cron and a
 * developer watching a conversation should not have to wait a minute to see a confirmation arrive.
 */
const interval = Number(process.env["WEBHOOK_DISPATCH_INTERVAL_MS"] ?? 0);

if (Number.isFinite(interval) && interval > 0) {
  const tick = (): void => {
    void main()
      .catch((error: unknown) => console.error("webhook-dispatch failed:", error))
      .finally(() => setTimeout(tick, interval));
  };
  tick();
} else {
  main()
    .catch((error: unknown) => {
      console.error("webhook-dispatch failed:", error);
      process.exitCode = 1;
    })
    .finally(() => {
      void prisma.$disconnect();
    });
}
