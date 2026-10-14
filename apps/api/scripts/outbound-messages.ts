// One pass of the WhatsApp outbox: queue the reminders that are due, cancel the ones nobody answered,
// then send everything owed (reminders, "go to the room", cancellation notices, documents links).
//
// Run it under pm2 as a loop -- OUTBOUND_INTERVAL_MS=30000 -- or from cron once a minute, exactly like
// scripts/webhook-dispatch.ts. Safe to overlap or to run twice: the database owns exactly-once, so a pass
// that is still running when the next starts cannot send a message twice.

import { prisma } from "../src/prisma/client.ts";
import { runOutboundPass } from "../src/modules/whatsapp/outbound-messages.ts";

async function main(): Promise<void> {
  const now = new Date();
  const tally = await runOutboundPass(now);

  const skipped = Object.entries(tally.skipped)
    .map(([reason, count]) => `skipped:${reason}=${count}`)
    .join(" ");

  // One line a person can read in a log, naming what happened rather than that it ran.
  console.log(
    `outbound-messages ${now.toISOString()} reminders_queued=${tally.remindersQueued} ` +
      `auto_cancelled=${tally.autoCancelled} superseded=${tally.superseded} sent=${tally.sent} ` +
      `retrying=${tally.retrying} failed=${tally.failed} ${skipped}`.trimEnd(),
  );
}

const interval = Number(process.env["OUTBOUND_INTERVAL_MS"] ?? 0);

if (Number.isFinite(interval) && interval > 0) {
  // A pass that overruns the interval is never overlapped by its own loop: the next one is scheduled
  // only after this one finishes.
  const tick = (): void => {
    void main()
      .catch((error: unknown) => console.error("outbound-messages failed:", error))
      .finally(() => setTimeout(tick, interval));
  };
  tick();
} else {
  main()
    .catch((error: unknown) => {
      console.error("outbound-messages failed:", error);
      process.exitCode = 1;
    })
    .finally(() => {
      void prisma.$disconnect();
    });
}
