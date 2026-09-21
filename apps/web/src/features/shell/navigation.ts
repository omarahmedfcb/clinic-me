import type { TranslationKey } from "../../i18n/strings.ts";

/**
 * The sidebar's sections, and which capability each one needs to appear.
 *
 * None of these screens exist yet — they are Phase 2 and later. They are listed anyway because the
 * shell's job in Phase 1 is to be reviewed, and a sidebar with one item does not show whether the
 * layout works or whether a receptionist and a doctor see different things.
 *
 * ## Capability, not role
 *
 * A `role: ["DOCTOR"]` list would be a second copy of the §8 matrix, kept by hand, in the frontend.
 * It would drift the first time the matrix changed and nothing would notice. Naming the capability
 * means the sidebar follows the matrix wherever it goes.
 *
 * **This is a display decision and nothing else.** `GET /auth/me` returns the permission summary as
 * a display hint (permissions.ts says so at length), and hiding a link is not access control. Every
 * one of these screens will carry `@RequirePermission()` on its own routes when it exists. A user
 * who guesses a URL must be stopped by the server, not by the absence of a link.
 */
export interface NavItem {
  key: TranslationKey;
  /** The §8 capability that makes this section visible. Undefined means everyone sees it. */
  capability?: string;
  /**
   * The path this section lives at, once it exists. Absent means "not built yet", which is what
   * renders the disabled span and the قريبًا badge rather than a link that goes nowhere.
   */
  path?: string;
  /**
   * Paths under a **different** prefix that still belong to this section — `/charges/:id` is the
   * desk, which is «المدفوعات». A nested path under `path` needs no entry: that is matched already.
   */
  owns?: readonly string[];
}

/**
 * Which nav item a path belongs to, or null when it belongs to none.
 *
 * Prefix-matched on a path segment boundary, so `/patients` claims `/patients/<id>` and could never
 * claim a future `/patients-archive`. The longest match wins, so a nested section can be carved out
 * of a broader one later without the broader one swallowing it.
 */
export function activeNavKey(path: string): TranslationKey | null {
  let best: { key: TranslationKey; length: number } | null = null;
  for (const item of NAV_ITEMS) {
    for (const owned of [item.path, ...(item.owns ?? [])]) {
      if (owned === undefined) continue;
      if (path !== owned && !path.startsWith(`${owned}/`)) continue;
      if (best === null || owned.length > best.length) best = { key: item.key, length: owned.length };
    }
  }
  return best?.key ?? null;
}

/**
 * Routes the shell renders that deliberately belong to no sidebar section.
 *
 * Listed rather than defaulted, because "no section is highlighted" is indistinguishable from a
 * missing `owns` entry — which is the bug this pair exists to catch. `shell-navigation.spec.ts`
 * fails the build when a route in `AppShell` is neither owned by an item nor named here.
 */
export const UNMAPPED_ROUTES: readonly string[] = [
  // The account menu, not a section of the clinic (Q38).
  "/me",
  // «مساعدة», 2026-09-15. A static page in the sidebar's foot, below the rule — not a section, and
  // deliberately not in NAV_ITEMS: the brief for the rebrand was that the sections stay as they are.
  "/help",
  // The desk is charge-scoped and opens from a payments row; it is «المدفوعات» and is listed as
  // owned there, so it does not appear here.
];

export const NAV_ITEMS: readonly NavItem[] = [
  { key: "shell.nav.today", path: "/day" },
  // A week or month calendar. Badged "قريبًا" and deliberately kept: the founder removed this on
  // 2026-09-03 and reversed himself the same day — "a week or month calendar is a real gap for
  // reception, not a convenience. A patient calls asking 'when is my appointment next week' and the
  // day view makes that a hunt. It's deferred, not cancelled, and the badge was honest." Scoped
  // into Phase 5. The badge stays for deferred work; it comes off only for cancelled work.
  // The badge came off when the book shipped (PR 13). It comes off for work that lands, never for
  // work that is merely deferred — the distinction the founder reversed himself on for this item.
  { key: "shell.nav.appointments", capability: "appointments.read", path: "/appointments" },
  // **`appointments.read`, and the capability it names has been wrong twice for the same reason.**
  //
  // "The queue is read-only for an owner" is the ruling: the owner loses the moves and keeps the
  // board. Gating this link on `appointments.queueActions` would hide the board — that was caught.
  // It was then gated on `appointments.write`, which was right until later the same day, when
  // `appointments.write` was split into a read half and a write half and the owner lost the write
  // half. From that moment this line hid the queue from the only role the sentence above is about,
  // and nothing failed: the sidebar is a display decision, so a wrongly hidden section produces a
  // green suite and a missing link.
  //
  // The rule the two mistakes share: **a link is gated by the capability of the thing you go there
  // to SEE, never by the capability of an action offered once you arrive.** The actions inside the
  // screen gate themselves.
  { key: "shell.nav.queue", capability: "appointments.read", path: "/queue" },
  { key: "shell.nav.patients", capability: "patients.browse", path: "/patients" },
  // The doctor's section: reading clinical content, which reception must never see (CLAUDE.md).
  // The قريبًا badge came off when the screen shipped — for work that lands, never for work that
  // is merely deferred (the founder's distinction, ruled 2026-09-03).
  { key: "shell.nav.visits", capability: "visits.readContent", path: "/visits" },
  // **`payments.read`, not `payments.record`** — R2 gives an admin the screen and not the act, and
  // the rule two items above is the one that decides it: a link is gated by the capability of what
  // you go there to see. The desk opens from a row here. The قريبًا badge came off because the
  // screen shipped, which is the only reason it ever comes off.
  // `/charges/:id` is the desk, which is where a payments row leads and so is the same section.
  { key: "shell.nav.payments", capability: "payments.read", path: "/payments", owns: ["/charges"] },
  { key: "shell.nav.schedules", capability: "doctorSchedules.manage", path: "/schedules" },
  { key: "shell.nav.services", capability: "services.manage", path: "/services" },
  // `users.manage` rather than `appointments.write`: the list is readable by anyone who can book,
  // but the only action on the screen is deactivation, and that is what the capability has to
  // match. A link that opens a screen whose every control is refused is worse than no link.
  { key: "shell.nav.doctors", capability: "users.manage", path: "/doctors" },
  // The badge came off when the screen shipped (PR 10) — for work that lands, never for work that
  // is merely deferred.
  { key: "shell.nav.users", capability: "users.manage", path: "/users" },
  // Phase 5 PR 14. `reports.financial` is NONE for reception and **own** for a doctor, who sees
  // their own patients' figures and is told on the screen that is what they are looking at.
  { key: "shell.nav.reports", capability: "reports.financial", path: "/reports" },
  // Phase 5 PR 11. `auditLog.read` is the capability of the thing you go there to see — which is
  // the rule two items above, and the only control on the screen is a filter.
  { key: "shell.nav.audit", capability: "auditLog.read", path: "/audit-log" },
  // The قريبًا badge came off when the screen shipped (PR 7h). It comes off for work that lands,
  // and stays on for work that is deferred — the founder's distinction, ruled 2026-09-03.
  { key: "shell.nav.settings", capability: "clinicSettings.manage", path: "/settings" },
  // Q38 removed «بيانات الطبيب المطبوعة» from the sidebar. Its fields are on the doctor's own
  // record in the Doctors screen, where the rest of that record already lives; a doctor edits their
  // own from the account menu, which is where a person's own details belong rather than in a list
  // of sections about the clinic.
];

/** Which sections this permission summary makes visible. `none` hides; `own` and `full` show. */
export function visibleNavItems(permissions: Record<string, string>): NavItem[] {
  return NAV_ITEMS.filter((item) => item.capability === undefined || permissions[item.capability] !== "none");
}
