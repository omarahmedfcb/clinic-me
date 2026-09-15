import { readFileSync } from "node:fs";
import path from "node:path";
import { CAPABILITIES } from "../../src/common/permissions.ts";
import { NAV_ITEMS } from "../../../web/src/features/shell/navigation.ts";
import {
  apiRoutes,
  countVerbDecorators,
  matchingRoutes,
  sourceFiles,
  stripComments,
  webCallSites,
  type RouteEntry,
} from "../../scripts/route-capabilities.ts";

/**
 * The route→capability manifest, asserted against the client. **Step 1**, ruled 2026-09-06.
 *
 * ## The defect class this closes
 *
 * A screen's knowledge of what it may do was written by hand in three places nothing compared: the
 * nav item's capability, the button's `me.permissions[...]` check, and the route's
 * `@RequirePermission`. Both directions of disagreement were silent — a wrongly hidden section
 * produces no error at all, and a wrongly shown button produces one only when a user clicks it.
 * Four sessions and four screens had gone into patching instances of it one at a time.
 *
 * The founder's ruling: *"A manifest generated from the API and asserted against the client turns
 * that into a test failure."*
 *
 * ## What this catches, and what it does not
 *
 * It catches: a client calling a path or verb no route serves (a rename, a typo, a moved route); a
 * capability named in the web app that is not in the matrix — which is the dangerous typo, because
 * `permissions["patients.wirte"]` is `undefined`, `undefined !== "none"`, and the control shows for
 * **everyone**; and a nav item gated on a capability that no route behind that screen requires,
 * which is the bug that hid the owner's queue.
 *
 * It does not catch a screen *fetching* something it may not read — the bug that took the queue
 * board down. Answering that needs the capability attached to the call rather than to the screen,
 * which is **step 2**, deferred to Phase 5 by the same ruling and recorded in `PHASE-5.md`.
 *
 * ## Why the parser's own honesty is asserted first
 *
 * The manifest is extracted by scanning text, because TypeScript 7 ships no JavaScript compiler API
 * (checked). Text scanning is the technique this project distrusts most: a pattern that quietly
 * stops matching yields a smaller manifest and a green suite, which is the exact failure mode the
 * manifest exists to end. So the first three tests assert that the extraction found everything,
 * cross-checked against a second and independent extraction. **They are the load-bearing ones**: if
 * they pass and everything below them passes, the "everything below" means something.
 */

const API_ROOT = path.resolve(__dirname, "..", "..");
const REPO_ROOT = path.resolve(API_ROOT, "..", "..");
const API_SRC = path.join(API_ROOT, "src");
const WEB_SRC = path.join(REPO_ROOT, "apps", "web", "src");

const ROUTES = apiRoutes(API_SRC, REPO_ROOT);
const CALLS = webCallSites(WEB_SRC, REPO_ROOT);

/** A second, deliberately dumber extraction: every `@RequirePermission("x")` anywhere in `src`. */
function capabilitiesByGrep(): Set<string> {
  const found = new Set<string>();
  for (const file of sourceFiles(API_SRC, [".ts"])) {
    if (file.endsWith(".spec.ts")) continue;
    for (const match of stripComments(readFileSync(file, "utf8")).matchAll(
      /@RequirePermission\(\s*"([^"]+)"/g,
    )) {
      if (match[1] !== undefined) found.add(match[1]);
    }
  }
  return found;
}

describe("the extraction found everything, cross-checked two ways", () => {
  test("one route per HTTP-verb decorator, with none lost on the way", () => {
    // This caught a real loss the day it was written: the decorator-to-method attachment used
    // `end < start` where the two indices are equal, so `@Get()` on `health.controller.ts` bound to
    // nothing and that route vanished from the manifest. 60 decorators, 59 routes. Now 60 and 60.
    expect(ROUTES).toHaveLength(countVerbDecorators(API_SRC));
  });

  test("every controller file contributes at least one route", () => {
    // A file the scanner cannot parse at all would otherwise sit at zero and be invisible.
    const controllers = sourceFiles(API_SRC, [".controller.ts"]).map((file) =>
      path.relative(REPO_ROOT, file).split(path.sep).join("/"),
    );
    const silent = controllers.filter((file) => !ROUTES.some((route) => route.source === file));
    expect(silent).toEqual([]);
  });

  test("the manifest and a plain grep agree on which capabilities guard routes", () => {
    // Two independent extractions of the same fact. The manifest walks decorators positionally and
    // joins controller prefixes; the grep just looks for the string. They can only agree if the
    // positional walk is finding the same decorators.
    const fromManifest = new Set(
      ROUTES.map((route) => route.capability).filter((cap): cap is string => cap !== null),
    );
    expect([...fromManifest].sort()).toEqual([...capabilitiesByGrep()].sort());
  });

  test("every client call site resolves to a path and a method", () => {
    // Two call sites pass the path in as a parameter (`json()` in patients-api, `write()` in
    // services-api) and are resolved one level up. An unresolvable site is reported rather than
    // skipped, because a scanner that silently shrinks is the thing being guarded against.
    expect(CALLS.unresolved).toEqual([]);
    expect(CALLS.resolved.length).toBeGreaterThan(40);
  });
});

describe("the client only calls routes the API serves", () => {
  test("every authFetch call matches a route in the manifest", () => {
    const orphans = CALLS.resolved
      .filter((site) => matchingRoutes(site, ROUTES).length === 0)
      .map((site) => `${site.method} ${site.path}  (${site.source})`);
    expect(orphans).toEqual([]);
  });
});

describe("every capability the web app names is a real capability", () => {
  /**
   * The silent direction, and the reason this test is worth more than it looks.
   *
   * `me.permissions["patients.wirte"]` is `undefined`. `undefined !== "none"` is `true`. So a typo
   * does not hide the control — **it shows it to every role**, including the ones the matrix says
   * hold nothing. Nothing throws, nothing renders differently in the author's own session, and the
   * server's 403 is the only remaining signal.
   */
  test("no capability string in apps/web is absent from the matrix", () => {
    const known = new Set<string>(CAPABILITIES);
    const unknown: string[] = [];

    for (const file of sourceFiles(WEB_SRC, [".ts", ".tsx"])) {
      const text = stripComments(readFileSync(file, "utf8"));
      const source = path.relative(REPO_ROOT, file).split(path.sep).join("/");
      for (const match of text.matchAll(/permissions\[\s*"([^"]+)"\s*\]/g)) {
        if (match[1] !== undefined && !known.has(match[1])) unknown.push(`${match[1]} (${source})`);
      }
      for (const match of text.matchAll(/\bcapability:\s*"([^"]+)"/g)) {
        if (match[1] !== undefined && !known.has(match[1])) unknown.push(`${match[1]} (${source})`);
      }
    }

    expect(unknown).toEqual([]);
  });
});

/**
 * Which feature directory each navigable section lives in.
 *
 * Hand-written, and small enough to stay honest — a wrong entry fails the test below loudly rather
 * than weakening it. Sections with no `path` are unbuilt and have no directory to check.
 */
const SCREEN_DIRECTORY: Record<string, string> = {
  "/day": "day-view",
  "/queue": "queue",
  "/patients": "patients",
  "/schedules": "schedules",
  "/services": "services",
  "/doctors": "doctors",
  // The doctor's open consultations. `/visits/:id` is the visit screen itself and is reached from
  // the queue or from this list, not from a nav item, so only the index is mapped here.
  "/visits": "visits",
  // Q38 left one settings screen in the sidebar. `/me` is reached from the account menu rather
  // than from a nav item, so it has no entry here — this map answers a question about links.
  // «المدفوعات» (R2). The desk itself is charge-scoped and reached from a row on this screen or
  // from the appointment panel, so it has no nav item and no entry here.
  // «المواعيد» (PR 13). The month book; the day panel and both dialogs live under it.
  "/appointments": "appointments",
  "/payments": "billing",
  // «تقارير المدفوعات» (PR 14). Same feature directory as the payments screen it reports on.
  "/reports": "billing",
  // «المستخدمون» (PR 10). Admin only, through `users.manage`.
  "/users": "staff",
  // «سجل التدقيق» (PR 11). Read-only; the only control on the screen is a filter.
  "/audit-log": "audit",
  "/settings": "settings",
};

describe("a nav item is gated on a capability its own screen actually needs", () => {
  /**
   * **The bug this reproduces.** `shell.nav.queue` was gated on `appointments.write`, correct until
   * the read/write split took that capability away from OWNER — after which the sidebar hid the
   * queue from the one role "the queue is read-only for an owner" is about. Nothing failed.
   *
   * The rule: a link is gated by the capability of what you go there to **see**. So the capability
   * must be required by a route the screen's own feature directory calls.
   *
   * Scoped to the screen's own directory deliberately, not to everything it imports. `QueuePage`
   * pulls in the booking dialog and the transfer panel, whose routes need `appointments.write` and
   * `patients.transfer` — but those are *actions offered once you arrive*, which by the rule above
   * are exactly what must not gate the link. Widening this to transitive imports would let the
   * original bug back in.
   */
  const capabilitiesCalledBy = (directory: string): Set<string> => {
    const prefix = `apps/web/src/features/${directory}/`;
    const out = new Set<string>();
    for (const site of CALLS.resolved) {
      if (!site.source.startsWith(prefix)) continue;
      for (const route of matchingRoutes(site, ROUTES)) {
        if (route.capability !== null) out.add(route.capability);
      }
    }
    return out;
  };

  for (const item of NAV_ITEMS) {
    if (item.path === undefined || item.capability === undefined) continue;
    const directory = SCREEN_DIRECTORY[item.path];

    test(`${item.key} is gated on a capability ${item.path} requires`, () => {
      expect(directory).toBeDefined();
      const required = capabilitiesCalledBy(directory as string);
      // Named in the message rather than only compared, so a failure says which capabilities the
      // screen does need instead of leaving the next reader to work it out.
      expect({
        gate: item.capability,
        requiredByTheScreen: [...required].sort(),
      }).toEqual({
        gate: item.capability,
        requiredByTheScreen: expect.arrayContaining([item.capability as string]),
      });
    });
  }
});

describe("the manifest itself is legible", () => {
  test("no two routes share a method and path", () => {
    // Two controllers claiming one path is a real hazard -- Nest serves whichever module registered
    // first -- and it would also make `matchingRoutes` return a capability union that hides one of
    // them behind the other.
    const seen = new Map<string, RouteEntry>();
    const duplicates: string[] = [];
    for (const route of ROUTES) {
      const key = `${route.method} ${route.path}`;
      const previous = seen.get(key);
      if (previous !== undefined) duplicates.push(`${key}: ${previous.source} and ${route.source}`);
      seen.set(key, route);
    }
    expect(duplicates).toEqual([]);
  });

  test("only the auth, health and platform routes are ungoverned by a capability", () => {
    // Everything else must name one. A new route with no `@RequirePermission` is a route open to
    // every authenticated caller in any clinic, which is a decision nobody would take on purpose
    // and which no other test in this repo would notice.
    const ungoverned = ROUTES.filter((route) => route.capability === null).map(
      (route) => `${route.method} ${route.path}`,
    );
    expect(ungoverned.sort()).toEqual([
      "GET /auth/me",
      "GET /health",
      /**
       * **The platform console is outside the capability matrix on purpose** — pilot-readiness 0a.
       *
       * `@RequirePermission` reads a role out of a clinic membership, and the operator holds no
       * membership in any clinic: asking which capability they hold is asking a question with no
       * subject. `PlatformAuthGuard` governs these instead, and it is stricter than the matrix —
       * it re-reads `is_platform_admin` from the database on every request.
       *
       * They are listed here rather than exempted by a pattern, so that a *third* `/platform/*`
       * route cannot become ungoverned without somebody adding a line to this list.
       */
      "GET /platform/me",
      "POST /auth/login",
      "POST /auth/logout",
      // PR 10. Deliberately ungoverned: it is the one route a holder of a temporary password may
      // reach, and it acts only on the caller's own account — a capability would be asking which
      // clinic a person may change their own password in, which is not a question.
      "POST /auth/password",
      "POST /auth/refresh",
      "POST /auth/switch-tenant",
      "POST /platform/login",
    ]);
  });
});
