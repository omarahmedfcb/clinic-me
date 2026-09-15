import { expect, test, type ConsoleMessage, type Page } from "@playwright/test";

/**
 * **Does the built bundle actually run?**
 *
 * The narrowest useful question, asked of every route the shell can reach. No content assertions —
 * see `playwright.config.ts` for why that is a rule rather than laziness.
 *
 * There is **no `test.skip()` in this file and there must never be one.** If the browser cannot
 * start, this fails. A smoke test that skips itself is a green tick attached to nothing.
 */

/** Every path `AppShell.tsx` routes, plus one it does not, which must still render its placeholder. */
const ROUTES = ["/", "/day", "/queue", "/schedules", "/services", "/patients"] as const;

/**
 * No API is running, so the app's own calls fail — that is expected and is not what this asserts.
 *
 * Kept as a narrow, explicit predicate rather than a general "ignore network errors": the point of
 * the console check is to notice a *bundle* that is broken, and a failed `/api` fetch says nothing
 * about the bundle. Anything else at `error` level fails the test.
 */
function isExpectedApiNoise(message: ConsoleMessage): boolean {
  const text = message.text();
  return (
    text.includes("/api/") ||
    text.includes("Failed to load resource") ||
    text.includes("net::ERR_") ||
    text.includes("ERR_CONNECTION_REFUSED")
  );
}

interface PageFaults {
  uncaught: string[];
  consoleErrors: string[];
}

function watch(page: Page): PageFaults {
  const faults: PageFaults = { uncaught: [], consoleErrors: [] };
  // An uncaught exception is the strongest signal available and needs no interpretation.
  page.on("pageerror", (error) => faults.uncaught.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" && !isExpectedApiNoise(message)) {
      faults.consoleErrors.push(message.text());
    }
  });
  return faults;
}

test.describe("the built bundle runs in a browser", () => {
  for (const route of ROUTES) {
    test(`${route} loads, mounts, and throws nothing`, async ({ page }) => {
      const faults = watch(page);

      const response = await page.goto(route, { waitUntil: "domcontentloaded" });
      // A 404 from the static server would make every assertion below vacuous.
      expect(response?.status(), `HTTP status for ${route}`).toBeLessThan(400);

      // The blank-page class, asserted directly: React mounted and put something in the DOM. This
      // is what "renders nothing" looks like from the outside, and it is the one thing a compiler
      // cannot tell you.
      await expect(page.locator("#root")).not.toBeEmpty();

      expect({
        route,
        uncaught: faults.uncaught,
        consoleErrors: faults.consoleErrors,
      }).toEqual({ route, uncaught: [], consoleErrors: [] });
    });
  }

  test("the document is right-to-left and Arabic, before any script runs", async ({ page }) => {
    // The one non-content assertion kept, because it is a property of the built `index.html` rather
    // than of a screen: `ARCHITECTURE.md` §2 requires `dir`/`lang` set in the markup, before first
    // paint, not applied by JavaScript after mount. A build step that dropped them would show up
    // here and nowhere else in the suite.
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    await expect(page.locator("html")).toHaveAttribute("lang", "ar");
  });
});
