import { readFileSync } from "node:fs";
import path from "node:path";
import { NAV_ITEMS } from "../../../web/src/features/shell/navigation.ts";

/**
 * **Every screen the onboarding kit sends somebody to exists.**
 *
 * The kit is read by a person sitting beside a clinic administrator with an hour booked. A step that
 * says "Services (`/services`)" when the route is called something else does not fail gracefully —
 * it fails in front of a customer, and the onboarder has no way to tell whether they misread the
 * document or the product moved.
 *
 * Derived from `NAV_ITEMS`, which is the app's own list of what exists and where. A route with no
 * `path` there renders "coming soon", and citing one of those in a setup checklist would be worse
 * than citing nothing.
 */
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const KIT = path.join(REPO_ROOT, "docs", "ONBOARDING-KIT.md");

/** Backticked absolute paths in the kit: `/settings`, `/doctors`, … */
function citedRoutes(): string[] {
  const text = readFileSync(KIT, "utf8");
  return [...new Set([...text.matchAll(/`(\/[a-z-]+)`/g)].map((match) => match[1] as string))];
}

const BUILT_ROUTES = NAV_ITEMS.flatMap((item) => (item.path === undefined ? [] : [item.path]));

describe("the onboarding kit sends people to screens that exist", () => {
  test("every route it cites is one the app actually serves", () => {
    const unknown = citedRoutes().filter((route) => !BUILT_ROUTES.includes(route));
    expect(unknown).toEqual([]);
  });

  test("it cites several, so a scan that stopped matching cannot pass", () => {
    expect(citedRoutes().length).toBeGreaterThanOrEqual(5);
  });

  test("the setup order names the four screens that block the ones after them", () => {
    // Identity, doctors, services, schedules — the order §1 is built on. A kit that lost one of
    // these would still read well and would strand a setup session on an empty list.
    const text = readFileSync(KIT, "utf8");
    for (const route of ["/settings", "/doctors", "/services", "/schedules", "/users"]) {
      expect(text).toContain(`\`${route}\``);
    }
  });
});
