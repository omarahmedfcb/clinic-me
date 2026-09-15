import { beforeEach, describe, expect, test, vi } from "vitest";
import { mayOpenVisit, openVisit, visitPath } from "./open-visit.ts";

/**
 * The way into the visit screen — the blocker found on review, 2026-09-07.
 *
 * The screen shipped with a route and nothing navigating to it: a `grep` for `/visits/` across
 * `apps/web/src` found the import and no link, so the only way in was typing a URL.
 *
 * The decision and the navigation live here rather than in each screen, so the queue row and the
 * appointment panel cannot disagree about who is offered the door. `web-visit-entry-points.spec.ts`
 * (apps/api) asserts both surfaces actually call it.
 */

beforeEach(() => {
  window.history.pushState(null, "", "/queue");
});

describe("who is offered the record", () => {
  const doctor = { "visits.write": "full" };
  const reception = { "visits.write": "none" };

  test("a doctor, once the patient is present", () => {
    for (const status of ["ARRIVED", "WAITING", "IN_CONSULTATION"]) {
      expect(mayOpenVisit(doctor, status)).toBe(true);
    }
  });

  test("not before the patient arrives, because the screen would refuse", () => {
    // The server decides presence; this only avoids offering a button that always fails.
    for (const status of ["BOOKED", "CONFIRMED", "COMPLETED", "CANCELLED", "NO_SHOW"]) {
      expect(mayOpenVisit(doctor, status)).toBe(false);
    }
  });

  test("never reception, at any status", () => {
    for (const status of ["ARRIVED", "WAITING", "IN_CONSULTATION", "BOOKED"]) {
      expect(mayOpenVisit(reception, status)).toBe(false);
    }
  });
});

describe("navigation", () => {
  test("the path is appointment-scoped, matching the route AppShell matches", () => {
    expect(visitPath("01a07b2b-1f85-7a54-a358-8889172b99ad")).toBe(
      "/visits/01a07b2b-1f85-7a54-a358-8889172b99ad",
    );
  });

  test("openVisit changes the URL and fires popstate, which is what AppShell listens on", () => {
    // pushState alone does not fire popstate, so without the dispatch the URL would change and the
    // screen would not -- which looks exactly like a dead button.
    const heard = vi.fn();
    window.addEventListener("popstate", heard);

    openVisit("01a07b2b-1f85-7a54-a358-8889172b99ad");

    expect(window.location.pathname).toBe("/visits/01a07b2b-1f85-7a54-a358-8889172b99ad");
    expect(heard).toHaveBeenCalledTimes(1);
    window.removeEventListener("popstate", heard);
  });
});
