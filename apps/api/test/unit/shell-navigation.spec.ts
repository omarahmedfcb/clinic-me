import { readFileSync } from "node:fs";
import path from "node:path";
import { permissionLevel, permissionSummary } from "../../src/common/permissions.ts";
import {
  activeNavKey,
  NAV_ITEMS,
  UNMAPPED_ROUTES,
  visibleNavItems,
} from "../../../web/src/features/shell/navigation.ts";

/**
 * The shell's sidebar, checked against the same §8 matrix the server enforces.
 *
 * The sidebar hides sections a role cannot use. **That is a display decision and not access
 * control** — every one of these screens will carry `@RequirePermission()` when it exists, and a
 * user who guesses a URL must be stopped by the server, not by a missing link. What these tests
 * assert is that the *display* follows the matrix rather than a second, hand-kept copy of it.
 */

const WEB_ROOT = path.resolve(__dirname, "..", "..", "..", "web");

describe("sidebar sections follow the permission matrix", () => {
  test("every capability a nav item names is a real capability", () => {
    // A typo would silently hide a section from everyone: `permissions["patients.wirte"]` is
    // undefined, which is not "none", so the item would show for all roles — or, with the opposite
    // typo, never. Either way nothing would fail.
    const summary = permissionSummary("OWNER");
    const unknown = NAV_ITEMS.filter(
      (item) => item.capability !== undefined && !(item.capability in summary),
    ).map((item) => item.capability);
    expect(unknown).toEqual([]);
  });

  test("a receptionist and a doctor do not see the same sidebar", () => {
    // The property the founder asked to see. If these ever match, the sidebar has stopped
    // reflecting the matrix and is decoration.
    const reception = visibleNavItems(permissionSummary("RECEPTIONIST")).map((item) => item.key);
    const doctor = visibleNavItems(permissionSummary("DOCTOR")).map((item) => item.key);
    expect(reception).not.toEqual(doctor);
  });

  test("reception cannot see the clinical section, and the doctor can", () => {
    // CLAUDE.md: clinical content is doctor-only. visits.readContent is the capability that draws
    // that line, and the sidebar must draw it in the same place.
    const reception = visibleNavItems(permissionSummary("RECEPTIONIST")).map((item) => item.key);
    const doctor = visibleNavItems(permissionSummary("DOCTOR")).map((item) => item.key);
    expect(reception).not.toContain("shell.nav.visits");
    expect(doctor).toContain("shell.nav.visits");
  });

  test("every staff role sees payments, and the screen is not the same screen twice", () => {
    // **R2, 2026-09-11, replacing "reception sees payments and the doctor does not".** The ruling
    // gives the screen to everyone and the act to almost nobody: reception and a flagged doctor
    // collect, an admin reads. So the nav item follows `payments.read`, which every staff role
    // holds, and what differs is inside the screen — `mayCollect` decides whether a desk button is
    // offered at all, and the route refuses regardless.
    for (const role of ["OWNER", "ADMIN", "DOCTOR", "RECEPTIONIST"] as const) {
      expect(visibleNavItems(permissionSummary(role)).map((i) => i.key)).toContain("shell.nav.payments");
    }
    // The half that must still hold: an admin holds the screen and not the act.
    expect(permissionLevel("ADMIN", "payments.read")).toBe("full");
    expect(permissionLevel("ADMIN", "payments.record")).toBe("none");
  });

  test("only OWNER and ADMIN see clinic settings and users", () => {
    for (const role of ["OWNER", "ADMIN"] as const) {
      const keys = visibleNavItems(permissionSummary(role)).map((item) => item.key);
      expect(keys).toContain("shell.nav.settings");
      expect(keys).toContain("shell.nav.users");
    }
    for (const role of ["DOCTOR", "RECEPTIONIST"] as const) {
      const keys = visibleNavItems(permissionSummary(role)).map((item) => item.key);
      expect(keys).not.toContain("shell.nav.settings");
      expect(keys).not.toContain("shell.nav.users");
    }
    // Q38 took the doctor's print details out of the sidebar: they are fields on the doctor's own
    // record in the Doctors screen, and a doctor edits their own from the account menu. A person's
    // own details are not a section of the clinic.
    for (const role of ["OWNER", "ADMIN", "DOCTOR", "RECEPTIONIST"] as const) {
      const keys = visibleNavItems(permissionSummary(role)).map((item) => item.key);
      expect(keys).not.toContain("shell.nav.doctorProfile");
    }
  });

  test("the patient book is reception's and admin's, and not the doctor's", () => {
    // The founder's ruling of 2026-09-03: doctors reach patients through their own queue and
    // history. This asserts the sidebar follows `patients.browse` rather than `patients.write`,
    // which every staff role holds -- the two are one character apart at the call site and the
    // wrong one would put the whole patient book back on the doctor's screen with nothing failing.
    for (const role of ["OWNER", "ADMIN", "RECEPTIONIST"] as const) {
      expect(visibleNavItems(permissionSummary(role)).map((i) => i.key)).toContain("shell.nav.patients");
    }
    expect(visibleNavItems(permissionSummary("DOCTOR")).map((i) => i.key)).not.toContain("shell.nav.patients");
  });

  test("no section is a permanent coming-soon: every item either has a path or is genuinely next", () => {
    // The founder's rule, 2026-09-03: "a permanent 'coming soon' that nothing is scheduled to
    // deliver is a promise nobody made -- and reception will keep clicking it." He reversed half of
    // it the same day, and the reversal is the more useful form of the rule: the badge is honest
    // for work that is **deferred** and dishonest only for work that is **cancelled**.
    //
    // So the reports screen stays out -- ARCHITECTURE.md §18 rejected the need -- while the
    // appointments calendar came back, because the need is real and is now Phase 5. Every entry
    // below carries which of the two it is; an item with neither a path nor a reason is the thing
    // this test exists to catch.
    const unbuilt = NAV_ITEMS.filter((item) => item.path === undefined).map((item) => item.key);
    expect(unbuilt).toEqual([
      // Nothing. Both remaining entries were built within two days of each other, which is why this
      // list is the one place in the suite that had to be reconciled when the two branches landed.
      //
      // `shell.nav.settings` left this list on 2026-09-09: PR 7h built the screen, so the badge came
      // off. That is the rule working in the direction it is usually not seen working in.
      // `shell.nav.visits` left it the same day, for the same reason: `/visits` is the doctor's open
      // consultations, so the badge came off work that landed rather than work that was cancelled.
      // `shell.nav.payments` left it on 2026-09-11: R2 built «المدفوعات», so the badge came off.
      // `shell.nav.users` left it the same way, when PR 10 built «المستخدمون».
      // `shell.nav.appointments` left it when PR 13 built the book — the item the founder once
      // removed and put back the same day, on exactly this distinction.
    ]);
  });

  test("the owner sees the queue, because the ruling was read-only and not hidden", () => {
    // **This is the assertion whose absence let the queue disappear from the owner's sidebar.**
    //
    // The 2026-09-06 ruling is one sentence: an owner may watch the board and may not move anyone
    // through it. The link was gated on `appointments.write`, which was correct until the same
    // day's read/write split took `appointments.write` away from OWNER — at which point the link
    // vanished for the one role the ruling is about. Nothing failed, because a sidebar is a
    // display decision and a wrongly hidden section is silent.
    //
    // Written as "the owner sees it AND the owner cannot act on it", because either half alone
    // passes under the wrong capability: gating on `queueActions` hides the board and still
    // satisfies "cannot act", and gating on nothing shows it and satisfies "can see".
    const owner = permissionSummary("OWNER");
    expect(visibleNavItems(owner).map((item) => item.key)).toContain("shell.nav.queue");
    expect(owner["appointments.queueActions"]).toBe("none");

    // And every other staff role keeps it, so the fix cannot have been "show it to everybody".
    for (const role of ["ADMIN", "DOCTOR", "RECEPTIONIST"] as const) {
      expect(visibleNavItems(permissionSummary(role)).map((i) => i.key)).toContain("shell.nav.queue");
    }
  });

  test("no nav item is gated on a capability that only an action needs", () => {
    // The general form of the bug above, stated as a rule rather than left to be rediscovered:
    // a link is gated by the capability of what you go there to SEE. A capability that exists to
    // guard a write can never be the right gate for a section, because the section is still worth
    // looking at by someone who may not write in it -- which is exactly the owner's queue, the
    // owner's patient book, and the owner's appointment calendar.
    //
    // Kept as an explicit list rather than a name-pattern match: `queueActions` and `completeVisit`
    // are writes whose names contain no verb a regex would catch, and a rule that silently stops
    // matching is worse than no rule.
    const WRITE_ONLY = [
      "appointments.write",
      "appointments.queueActions",
      "appointments.completeVisit",
      "appointments.overrideSlotConflict",
      "patients.write",
      "patients.transfer",
      "patients.merge",
      "visits.write",
      "prescriptions.write",
      "payments.adjust",
    ];
    const offenders = NAV_ITEMS.filter(
      (item) => item.capability !== undefined && WRITE_ONLY.includes(item.capability),
    ).map((item) => `${item.key} -> ${item.capability ?? ""}`);
    expect(offenders).toEqual([]);
  });

  test("every role sees at least one section, so nobody lands on an empty shell", () => {
    for (const role of ["OWNER", "ADMIN", "DOCTOR", "RECEPTIONIST"] as const) {
      expect(visibleNavItems(permissionSummary(role)).length).toBeGreaterThan(1);
    }
  });
});

describe("logout clears the cached locale through the shared helper", () => {
  const session = readFileSync(path.join(WEB_ROOT, "src", "features", "auth", "session.tsx"), "utf8");

  test("it calls clearCachedLocale rather than reimplementing it", () => {
    // D20's shared-workstation case: reception shares one browser profile, so a doctor's English
    // preference must not persist into whoever signs in next. `clearCachedLocale` is the tested
    // path (web-locale.spec.ts); a second implementation here would be a second thing to keep
    // correct, and the one nobody tests.
    expect(session).toContain("clearCachedLocale");
  });

  test("it does not remove the locale key by hand", () => {
    // The specific way this would drift: someone inlines `removeItem("clinic-os.locale")` here,
    // the D20 test still passes because it tests the helper, and the real logout path stops
    // clearing anything the day the key name changes.
    expect(session).not.toMatch(/removeItem\s*\(/);
    expect(session).not.toContain("clinic-os.locale");
  });

  test("the logout path reaches endSession, which is where the clearing happens", () => {
    // Guards the wiring rather than the helper: a logout that revokes the family server-side but
    // never calls endSession would leave the locale cached and the user still in the shell.
    expect(session).toMatch(/logout[\s\S]{0,400}endSession\(\)/);
  });
});

describe("the sidebar says which section you are in, on every route", () => {
  const shell = readFileSync(
    path.join(WEB_ROOT, "src", "features", "shell", "AppShell.tsx"),
    "utf8",
  );

  /**
   * Every path the shell can render, read out of `AppShell` rather than listed by hand.
   *
   * Two shapes: the literal comparisons (`path === "/day"`) and the parameterised routes, which are
   * matched by a regular expression against a prefix (`/^\/patients\/([0-9a-fA-F-]{36})$/`). Both
   * are collected, because a route that highlights nothing is invisible either way.
   */
  const literals = [...shell.matchAll(/path === "(\/[^"]*)"/g)].map((m) => m[1] as string);
  const parameterised = [...shell.matchAll(/\/\^\\\/([a-z-]+)\\\//g)].map(
    (m) => `/${m[1] as string}/x`,
  );
  const routes = [...new Set([...literals, ...parameterised])];

  test("the guard can see the routes it is guarding, so an empty pass is impossible", () => {
    // Without this, a change to how routes are written in `AppShell` would empty the list and every
    // assertion below would pass by having nothing to check -- the vacuity trap this project keeps
    // finding in its own guards.
    expect(routes.length).toBeGreaterThan(8);
    expect(routes).toContain("/day");
    expect(routes.some((route) => route.startsWith("/patients/"))).toBe(true);
  });

  test("every route maps to a nav section, or is explicitly listed as unmapped", () => {
    // **The bug: the sidebar went blank on every nested route.** `path === item.path` is true only
    // on the index, so opening a patient, a visit or the desk un-highlighted the section — the
    // screen stopped saying where you were exactly when you had navigated somewhere.
    const orphans = routes.filter(
      (route) => activeNavKey(route) === null && !UNMAPPED_ROUTES.includes(route),
    );
    expect(orphans).toEqual([]);
  });

  test("a nested route highlights the section it belongs to, not the one it starts with", () => {
    expect(activeNavKey("/visits/0f4d1c3e-0000-7000-8000-000000000000")).toBe("shell.nav.visits");
    expect(activeNavKey("/patients/0f4d1c3e-0000-7000-8000-000000000000")).toBe("shell.nav.patients");
    // The desk is reached from a payments row and is the same section, though its path differs.
    expect(activeNavKey("/charges/0f4d1c3e-0000-7000-8000-000000000000")).toBe("shell.nav.payments");
    expect(activeNavKey("/payments")).toBe("shell.nav.payments");
  });

  test("ownership is matched on a segment boundary, never on a bare prefix", () => {
    // `/patients-archive` is not the patient book. A `startsWith` without the boundary would claim
    // it, and the section would highlight on a screen it has nothing to do with.
    expect(activeNavKey("/patients-archive")).toBeNull();
    expect(activeNavKey("/me")).toBeNull();
  });
});
