// The route guard, and logout forgetting the screen (found in the #231 preview): a role that may not see a section is sent home
// rather than shown its screen, for every section by one rule; and after logout the next login lands home, whoever it is.
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ToastProvider } from "../../design-system/Toast.tsx";
import { LocaleProvider } from "../../i18n/locale-context.tsx";
import { t } from "../../i18n/strings.ts";
import { App } from "../../App.tsx";
import { SessionProvider, type CurrentUser } from "../auth/session.tsx";
import { AppShell } from "./AppShell.tsx";
import { HOME_PATH, NAV_ITEMS } from "./navigation.ts";

const CAPABILITIES = [...new Set(NAV_ITEMS.flatMap((item) => (item.capability === undefined ? [] : [item.capability])))];
const member = (role: string, denied: readonly string[]): CurrentUser => ({
  user: { id: "u1", fullName: "منى", phoneE164: "+201000000000", email: null, locale: null },
  membershipId: "m1", tenantId: "t1", currency: "EGP", role,
  memberships: [{ membershipId: "m1", tenantId: "t1", tenantName: "عيادة النيل", tenantSlug: "nile", role }],
  permissions: Object.fromEntries(CAPABILITIES.map((c) => [c, denied.includes(c) ? "none" : "full"])),
});
const RECEPTIONIST = member("RECEPTIONIST", ["clinicSettings.manage", "users.manage", "auditLog.read", "reports.financial", "services.manage", "doctorSchedules.manage", "visits.readContent"]);

function stubApi(me: CurrentUser) {
  vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener: () => {}, removeEventListener: () => {} }));
  vi.stubGlobal("fetch", vi.fn(async (input: string) => {
    const path = new URL(String(input), "http://localhost").pathname;
    const body = path === "/api/auth/refresh" ? { accessToken: "t" } : path === "/api/auth/me" ? me : path === "/api/whatsapp/connection" ? { connection: null }
      : path === "/api/notifications/count" ? { unread: 0, latestId: null } : path === "/api/auth/logout" ? {} : [];
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }));
}
function renderShellAt(path: string, me: CurrentUser) {
  stubApi(me);
  window.history.pushState({}, "", path);
  render(<LocaleProvider><ToastProvider><SessionProvider initialToken="t" initialMe={me} onSignedOut={() => {}}><AppShell /></SessionProvider></ToastProvider></LocaleProvider>);
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.pushState({}, "", "/");
});

describe("the route guard", () => {
  test("a receptionist sent to /settings is redirected home, and the settings form never renders", async () => {
    renderShellAt("/settings", RECEPTIONIST);
    await waitFor(() => expect(window.location.pathname).toBe(HOME_PATH));
    expect(screen.queryByTestId("clinic-settings")).toBeNull();
    expect(screen.queryByTestId("save-clinic")).toBeNull();
  });

  test("an admin who holds the capability stays on /settings", async () => {
    renderShellAt("/settings", member("ADMIN", []));
    expect(await screen.findByTestId("clinic-settings")).toBeTruthy();
    expect(window.location.pathname).toBe("/settings");
  });

  test.each(NAV_ITEMS.filter((item) => item.capability !== undefined && item.path !== undefined).map((item) => [item.path!, item.capability!]))(
    "every guarded section: %s without %s goes home",
    async (path, capability) => {
      renderShellAt(path, member("RECEPTIONIST", [capability]));
      await waitFor(() => expect(window.location.pathname).toBe(HOME_PATH));
    },
  );
});

describe("logout forgets the screen", () => {
  test("after logging out of /settings the address is home, so the next login lands there", async () => {
    stubApi(member("ADMIN", []));
    window.history.pushState({}, "", "/settings");
    render(<LocaleProvider><ToastProvider><App /></ToastProvider></LocaleProvider>);
    expect(await screen.findByTestId("clinic-settings")).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: t("shell.logout") })[0]!);
    await waitFor(() => expect(window.location.pathname).toBe(HOME_PATH));
  });
});
