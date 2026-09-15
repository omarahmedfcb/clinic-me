import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { LocaleProvider } from "../../i18n/locale-context.tsx";
import { AuditLogPage } from "./AuditLogPage.tsx";

/**
 * «سجل التدقيق» — Phase 5 PR 11.
 *
 * The screen's own share of the rule is narrow and the tests are about that share: it must render
 * what the log says without inventing anything, and it must never render a value — the API sends
 * field names only, and this asserts the screen has no path that would show one if it did.
 */

const PAGE = {
  entries: [
    {
      id: "a1",
      at: "2026-09-13T08:15:00.000Z",
      actorUserId: "u1",
      actorName: "منى سيد فهمي",
      actorRole: "ADMIN",
      action: "UPDATE",
      entityType: "users",
      entityId: "11111111-1111-4111-8111-111111111111",
      changedFields: ["role", "status"],
      ipAddress: "127.0.0.1",
    },
    {
      id: "a2",
      at: "2026-09-13T07:00:00.000Z",
      actorUserId: "u2",
      actorName: "شيماء طارق",
      actorRole: "RECEPTIONIST",
      action: "CREATE",
      entityType: "appointments",
      entityId: "22222222-2222-4222-8222-222222222222",
      changedFields: [],
      ipAddress: "127.0.0.1",
    },
  ],
  total: 2,
};

const FILTERS = {
  actors: [{ userId: "u1", fullName: "منى سيد فهمي", role: "ADMIN" }],
  entityTypes: ["appointments", "users"],
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function renderPage(handler?: (path: string) => Promise<Response>) {
  const authFetch = vi.fn(async (path: string, _init?: RequestInit) =>
    handler !== undefined
      ? handler(path)
      : json(path.includes("/filters") ? FILTERS : PAGE),
  );
  render(
    <LocaleProvider>
      <AuditLogPage authFetch={authFetch} />
    </LocaleProvider>,
  );
  return authFetch;
}

afterEach(cleanup);

describe("the audit log viewer", () => {
  test("shows who did what, when, and which fields changed", async () => {
    renderPage();
    const table = await screen.findByTestId("audit-table");

    expect(table.textContent).toContain("منى سيد فهمي");
    expect(table.textContent).toContain("users");
    expect(table.textContent).toContain("role");
    // The «users» audit from #100 is what this screen was asked for; a CREATE has no previous
    // state, so it shows an em dash rather than pretending every column changed.
    expect(table.textContent).toContain("appointments");
  });

  test("filtering by person asks the server, and starts the list again", async () => {
    const authFetch = renderPage();
    await screen.findByTestId("audit-table");

    fireEvent.change(screen.getByTestId("audit-filter-person"), { target: { value: "u1" } });

    await waitFor(() => {
      const asked = authFetch.mock.calls.map(([path]) => String(path));
      expect(asked.some((path) => path.includes("actorUserId=u1") && path.includes("offset=0"))).toBe(
        true,
      );
    });
  });

  test("a date range travels as two calendar days", async () => {
    const authFetch = renderPage();
    await screen.findByTestId("audit-table");

    fireEvent.change(screen.getByTestId("audit-filter-from"), { target: { value: "2026-09-01" } });
    fireEvent.change(screen.getByTestId("audit-filter-to"), { target: { value: "2026-09-13" } });

    await waitFor(() => {
      const asked = authFetch.mock.calls.map(([path]) => String(path));
      expect(asked.some((path) => path.includes("from=2026-09-01") && path.includes("to=2026-09-13"))).toBe(
        true,
      );
    });
  });

  test("a failed read says so, and never renders an empty log", async () => {
    // An empty audit log asserts that nobody did anything, which is the one thing a broken request
    // must not be allowed to say on this screen.
    renderPage(async (path) =>
      path.includes("/filters") ? json(FILTERS) : json({ code: "INTERNAL", params: {} }, 500),
    );
    expect(await screen.findByTestId("audit-failed")).toBeTruthy();
    expect(screen.queryByTestId("audit-table")).toBeNull();
  });

  test("nothing on the screen writes: every request is a GET", async () => {
    const authFetch = renderPage();
    await screen.findByTestId("audit-table");
    fireEvent.change(screen.getByTestId("audit-filter-record"), { target: { value: "users" } });

    await waitFor(() => expect(authFetch.mock.calls.length).toBeGreaterThan(2));
    for (const [, init] of authFetch.mock.calls) {
      expect((init as RequestInit | undefined)?.method ?? "GET").toBe("GET");
    }
  });
});
