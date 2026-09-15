import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

/**
 * The web app's test runner — added 2026-09-06, dependency decision approved by the founder.
 *
 * ## Why a separate config from `vite.config.ts`
 *
 * That file carries the dev server, the HTTPS plugin, the API proxy and the production build. None
 * of it applies to a test run, and `mkcert` in particular generates certificates by its presence
 * alone. Merging the two would mean a `test` block guarded by conditionals that a reader has to
 * evaluate in their head to know what a run does.
 *
 * The React plugin *is* shared, because the tests compile the same JSX the app does.
 *
 * ## Why this runner exists at all, rather than the API's jest
 *
 * Because it already failed there. `web-password-toggle.spec.ts` lived under `apps/api/test/unit`,
 * rendered the component with `react-dom/server`, and passed locally while failing on CI — the API
 * job runs inside `apps/api` with its own `npm ci`, so `apps/web/node_modules` does not exist on
 * that runner. Every `web-*.spec.ts` there is a source-text check for the same reason, which cannot
 * click a button or read the DOM that results.
 *
 * A runner that lives beside the code it tests has the app's own React, its own JSX pipeline, and
 * a DOM. Migrating the remaining `web-*` specs is deliberately a later batch — this change moves
 * exactly one, the one whose source check was weakest.
 */
export default defineConfig({
  plugins: [react()],
  test: {
    // jsdom, not happy-dom: `fireEvent.click` on a `<button type="submit">` inside a form must
    // actually attempt a submit for the "peeking does not submit" assertion to mean anything, and
    // form semantics are the part of the DOM most often thinned out in a lighter implementation.
    environment: "jsdom",
    globals: false,
    // Fails any test that formats a date or time with Arabic-Indic digits. Global so a new screen
    // cannot miss it; see the file for why the formatters are watched rather than the DOM.
    setupFiles: ["src/test-setup.ts"],
    include: ["src/**/*.spec.tsx", "src/**/*.spec.ts"],
    // The Playwright smoke suite drives a real browser against a built bundle and is run by
    // `npm run smoke`. Without this, vitest collects its files as unit tests and they fail on the
    // missing Playwright runner, which reads as a broken test suite rather than a misconfiguration.
    exclude: ["node_modules/**", "dist/**", "e2e/**", "tests/**"],
  },
});
