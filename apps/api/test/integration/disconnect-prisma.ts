// Every integration spec file closes its Prisma client when it finishes. Registered once here
// rather than written into each spec, so a new spec cannot forget and nobody has to remember.

import { prisma } from "../../src/prisma/client.ts";

/**
 * Jest resets the module registry between test *files*, so `src/prisma/client.ts` is evaluated
 * again for each one and every file holds its own `PrismaClient` with its own pool. Under
 * `--runInBand` all of those live in a single process, and a client nobody disconnects keeps its
 * pool — and everything the client reaches — alive for the rest of the run.
 *
 * That is what exhausted the runner: 66 suites in one process reached Node's default 2 GB ceiling
 * and aborted with every suite passing. Fifty-six specs already did this by hand and ten did not,
 * which is the shape of inconsistency that gets worse rather than better as specs are added.
 *
 * `$disconnect()` is idempotent, so the fifty-six that call it themselves are unaffected.
 */
afterAll(async () => {
  await prisma.$disconnect();
});
