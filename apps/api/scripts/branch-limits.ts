// One pass over ended branch-limit grace periods (BRANCHES-DESIGN §9 A, step 6.3). Run daily from cron — docs/SERVER-SETUP.md.
// Safe to repeat: a deferred grace is retried, and a branch with a future booking is never suspended.
import { enforceBranchLimits } from "../src/modules/branches/branch-limit-grace.ts";
import { prisma } from "../src/prisma/client.ts";

async function main(): Promise<void> {
  const now = new Date();
  const outcomes = await enforceBranchLimits(now);
  const tally = (status: string) => outcomes.filter((o) => o.status === status).length;
  console.log(
    `branch-limits ${now.toISOString()} graces=${outcomes.length} done=${tally("DONE")} deferred=${tally("DEFERRED")} cleared=${tally("CLEARED")} ` +
      `suspended=${outcomes.reduce((n, o) => n + o.suspended.length, 0)} held_by_bookings=${outcomes.reduce((n, o) => n + o.deferred.length, 0)}`,
  );
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
