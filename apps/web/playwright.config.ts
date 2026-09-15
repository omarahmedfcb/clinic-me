import { defineConfig, devices } from "@playwright/test";

/**
 * The smoke test: **load the built bundle in a real browser.**
 *
 * Nothing in this project had ever done that. `npm test` runs Jest against source in `apps/api`,
 * the new `web` CI job compiles `apps/web`, and neither of them executes the result. Between "it
 * compiles" and "it renders" there is a gap that had swallowed at least one bug for two review
 * cycles — `062ae51`, where every route rendered blank because a build plugin injected its preamble
 * into a comment. Compilation was perfectly happy.
 *
 * ## Deliberately narrow, and it must stay that way
 *
 * Load the routes, assert the app mounted and threw nothing. **No content assertions.** The moment
 * this starts checking what a screen says, it becomes a second test suite duplicating the first,
 * drifts from it, and rots — and the founder made that a condition. Its whole value is that it is
 * cheap enough to always run and broad enough to catch "the page is dead".
 *
 * That condition governs `smoke.spec.ts` and still does. `print-and-layout.spec.ts` was added on
 * 2026-09-09 with the founder's approval under a stated boundary: it asserts only what jsdom cannot
 * evaluate at all — the `@media print` cascade, and layout geometry. A unit test cannot duplicate
 * either, which is the property that keeps the two suites from drifting into each other.
 *
 * ## It must fail, never skip
 *
 * `forbidOnly` and zero retries, and **no `test.skip()` anywhere in the spec.** A smoke test that
 * quietly skips because Chromium did not install is worse than no smoke test: CI goes green while
 * nothing was checked, which is this project's most-repeated failure shape. If the browser cannot
 * start, Playwright throws and the job fails — that is the intended behaviour, not an inconvenience
 * to be worked around with a conditional.
 *
 * ## Why `vite preview` and not a static server
 *
 * `http-server` was approved and is not used: `vite preview` already serves `dist/` and needs no
 * extra package. `preview:fresh` is deliberately the command, so the bundle under test is one this
 * run built — the same guarantee `PHASE-4.md` §0 is about. A smoke test against a stale `dist/`
 * would be the exact fault it exists to catch, wearing a test's clothes.
 */
// Declared rather than pulled in with `@types/node`: this file is the only one in `apps/web` that
// reads an environment variable, and a dependency is the founder's call, not a config's.
declare const process: { env: Record<string, string | undefined> };

// `E2E_PORT` so this suite can run while a review build is being looked at on 4173. Same server,
// same freshness rule — a different door, because taking the founder's review stack down to run
// tests is not a trade this project makes.
const PORT = Number(process.env.E2E_PORT ?? 4173);
const BASE_URL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: true,
  retries: 0,
  reporter: [["list"]],
  timeout: 30_000,

  use: {
    // `localhost`, not `127.0.0.1`: `vite preview` binds IPv6 loopback only, so 127.0.0.1 is
    // refused outright. Polling the wrong one looks exactly like a server that never started.
    baseURL: BASE_URL,
    // Nothing is retried and nothing is recorded on success: this suite is meant to be boring.
    trace: "retain-on-failure",
  },

  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],

  webServer: {
    // Builds, then serves what it just built. Spelled out rather than delegated to `smoke:serve`,
    // so the port lives in one place and npm's cross-platform variable expansion is not involved.
    command: `npm run build && npx vite preview --port ${PORT} --strictPort`,
    url: BASE_URL,
    // Never reuse: an already-running preview is very likely serving an older bundle, which is the
    // failure this whole file exists to detect.
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
