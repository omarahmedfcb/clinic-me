import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * Every integration spec file disconnects its Prisma client, and the mechanism that guarantees it
 * is wired.
 *
 * **The failure this exists to prevent.** Jest resets the module registry between test files, so
 * each integration spec evaluates `src/prisma/client.ts` again and holds its own `PrismaClient`.
 * Under `--runInBand` they all live in one process, and a client nobody disconnects keeps its pool
 * alive for the rest of the run. On 2026-09-14 that reached Node's default ~2 GB ceiling at 66
 * suites and aborted — **with every suite reported passing**, which is the worst shape of failure
 * this project keeps finding: it looks like a flake, it is not one, and it recurs.
 *
 * Fifty-six specs called `$disconnect()` by hand and ten did not. Rather than editing ten files and
 * relying on the sixty-seventh author to remember, the disconnect moved into `setupFilesAfterEnv`,
 * where it applies to every spec by construction. This asserts that wiring is still there — a hook
 * silently dropped from the config looks exactly like one that works, right up until CI aborts.
 */

const API_ROOT = path.resolve(__dirname, "..", "..");
const HOOK = "test/integration/disconnect-prisma.ts";

interface ProjectConfig {
  displayName?: string;
  setupFilesAfterEnv?: string[];
}

describe("every integration spec disconnects its Prisma client", () => {
  // Required, not imported for its side effects: `jest.config.js` is CommonJS and this reads it as
  // data, so the assertion is about the file CI actually runs rather than about a copy of it.
  const config = require(path.join(API_ROOT, "jest.config.js")) as { projects: ProjectConfig[] };
  const integration = config.projects.find((project) => project.displayName === "integration");

  test("the integration project exists and is the one that runs against a database", () => {
    expect(integration).toBeDefined();
  });

  test("the disconnect hook is registered after the test framework, not before it", () => {
    // `setupFiles` runs before Jest installs its globals, so `afterAll` is undefined there. A hook
    // moved to the wrong key would throw at load — but only on a machine that runs it.
    const after = integration?.setupFilesAfterEnv ?? [];
    expect(after.some((entry) => entry.includes("disconnect-prisma"))).toBe(true);
  });

  test("the hook file exists and actually disconnects", () => {
    const file = path.join(API_ROOT, HOOK);
    expect(existsSync(file)).toBe(true);
    const source = readFileSync(file, "utf8");
    expect(source).toContain("afterAll");
    expect(source).toContain("$disconnect");
  });
});
