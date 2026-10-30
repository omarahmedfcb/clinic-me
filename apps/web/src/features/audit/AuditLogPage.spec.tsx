import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { LocaleProvider } from "../../i18n/locale-context.tsx";
import { AuditLogPage } from "./AuditLogPage.tsx";

/**
 * «سجل التدقيق» — Phase 5 PR 11, grouped by transaction 2026-10-29.
 *
 * The screen's own share of the rule is narrow and the tests are about that share: it must render
 * what the log says without inventing anything — no value, and no order inside one transaction.
 */

const entry = (id: string, action: string, entityType: string, changedFields: string[]) => ({
  id,
  at: "2026-09-13T08:15:00.000Z",
  actorUserId: "u1",
  actorName: "منى سيد فهمي",
  actorRole: "ADMIN",
  action,
  entityType,
  entityId: `${id}111111-1111-4111-8111-111111111111`,
  changedFields,
  ipAddress: "127.0.0.1",
  scope: "ONE_BRANCH",
});

const PAGE = {
  events: [
    {
      at: "2026-09-13T08:15:00.000Z",
      actorUserId: "u1",
      actorName: "منى سيد فهمي",
      actorRole: "ADMIN",
      reach: null,
      entryCount: 3,
      entries: [entry("a1", "UPDATE", "users", ["role", "status"]), entry("a2", "CREATE", "memberships", []), entry("a3", "UPDATE", "doctors", ["title"])],
    },
    {
      at: "2026-09-13T07:00:00.000Z",
      actorUserId: "u2",
      actorName: "شيماء طارق",
      actorRole: "RECEPTIONIST",
      reach: null,
      entryCount: 1,
      entries: [{ ...entry("b1", "CREATE", "appointments", []), actorUserId: "u2", actorName: "شيماء طارق" }],
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
  test("one transaction is one collapsed row: who, when, and how many changes", async () => {
    renderPage();
    const events = await screen.findAllByTestId("audit-event");
    expect(events).toHaveLength(2);
    expect(events[0]!.textContent).toContain("منى سيد فهمي");
    expect(within(events[0]!).getByTestId("audit-event-count").textContent).toBe("3 تغييرات");
    expect(within(events[1]!).getByTestId("audit-event-count").textContent).toBe("تغيير واحد");
    expect(screen.queryByTestId("audit-entry")).toBeNull();
  });

  test("expanded, the rows show entity, action and changed fields, with no ordinal", async () => {
    renderPage();
    const [first] = await screen.findAllByTestId("audit-event");
    fireEvent.click(within(first!).getByRole("button"));
    const list = within(first!).getByTestId("audit-event-entries");
    expect(list.tagName).toBe("UL");
    const rows = within(list).getAllByTestId("audit-entry");
    expect(rows).toHaveLength(3);
    expect(list.textContent).toContain("users");
    expect(list.textContent).toContain("role");
    for (const row of rows) expect(row.textContent).not.toMatch(/^\s*\d+[.)]/);
  });

  test("a large event counts all its changes, lists the first fifty, and says how many more there are", async () => {
    const fifty = Array.from({ length: 50 }, (_, i) => entry(`c${String(i).padStart(2, "0")}`, "UPDATE", "appointments", ["branch_id"]));
    renderPage(async (path) =>
      json(path.includes("/filters") ? FILTERS : { ...PAGE, events: [{ ...PAGE.events[0]!, entryCount: 5772, entries: fifty }] }),
    );
    const [event] = await screen.findAllByTestId("audit-event");
    expect(within(event!).getByTestId("audit-event-count").textContent).toBe("5772 تغييرًا");
    fireEvent.click(within(event!).getByRole("button"));
    expect(within(event!).getAllByTestId("audit-entry")).toHaveLength(50);
    expect(within(event!).getByTestId("audit-event-more").textContent).toContain("و5722 غيرها");
  });

  test("a single-branch clinic sees no branch label; a labelled event reads as predating branches", async () => {
    renderPage();
    await screen.findAllByTestId("audit-event");
    expect(screen.queryByTestId("audit-event-reach")).toBeNull();
    cleanup();

    renderPage(async (path) =>
      json(path.includes("/filters") ? FILTERS : { ...PAGE, events: [{ ...PAGE.events[0]!, reach: "BEFORE_BRANCHES" }] }),
    );
    expect((await screen.findByTestId("audit-event-reach")).textContent).toBe("قبل الفروع");
  });

  test("filtering by person asks the server, and starts the list again", async () => {
    const authFetch = renderPage();
    await screen.findByTestId("audit-events");

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
    await screen.findByTestId("audit-events");

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
    expect(screen.queryByTestId("audit-events")).toBeNull();
  });

  test("nothing on the screen writes: every request is a GET", async () => {
    const authFetch = renderPage();
    await screen.findByTestId("audit-events");
    fireEvent.change(screen.getByTestId("audit-filter-record"), { target: { value: "users" } });

    await waitFor(() => expect(authFetch.mock.calls.length).toBeGreaterThan(2));
    for (const [, init] of authFetch.mock.calls) {
      expect((init as RequestInit | undefined)?.method ?? "GET").toBe("GET");
    }
  });
});
