// Characterises the schedule editor as it behaves today: who it loads, what it sends, what it hides.
// Written before splitting the file, so the split has something that can fail if behaviour moves.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { LocaleProvider } from "../../i18n/locale-context.tsx";
import { t, type TranslationKey } from "../../i18n/strings.ts";
import { downloadCsv, downloadFile } from "./download.ts";
import { SchedulesPage } from "./SchedulesPage.tsx";

vi.mock("./download.ts", () => ({ downloadCsv: vi.fn(), downloadFile: vi.fn() }));

const DOCTORS = [
  { id: "d1", membershipId: "m1", fullName: "Amal Hassan", title: "Dr.", specialty: "Dermatology", licenseNumber: "1", isActive: true },
  { id: "d2", membershipId: "m2", fullName: "Omar Said", title: "Dr.", specialty: "Paediatrics", licenseNumber: "2", isActive: true },
];

const template = (weekday: number) => ({
  id: `t${weekday}`,
  weekday,
  startTime: "09:00",
  endTime: "17:00",
  validFrom: "2026-01-01",
  validTo: null,
  breaks: [],
});

const SCHEDULES: Record<string, unknown> = {
  d1: {
    doctorId: "d1",
    templates: [6, 0, 1, 2, 3, 4].map(template),
    exceptions: [
      { id: "e1", doctorId: "d1", date: "2026-11-02", type: "BLOCKED", startTime: "10:00", endTime: "11:00", reason: "meeting" },
    ],
  },
  d2: { doctorId: "d2", templates: [], exceptions: [] },
};

const weekFrom = (from: string) =>
  [0, 1, 2, 3, 4, 5, 6].map((offset) => {
    const at = new Date(`${from}T12:00:00Z`);
    at.setUTCDate(at.getUTCDate() + offset);
    return { date: at.toISOString().slice(0, 10), working: [], busy: [], free: [], fullyBooked: false };
  });

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

type Call = { path: string; method: string; body: unknown };
let calls: Call[] = [];
let overrides: Record<string, () => Response> = {};

async function api(path: string, init?: RequestInit): Promise<Response> {
  const method = init?.method ?? "GET";
  calls.push({ path, method, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
  const override = overrides[`${method} ${path.split("?")[0]}`];
  if (override !== undefined) return override();
  if (path === "/api/doctors") return json(DOCTORS);
  const schedule = /^\/api\/doctors\/(\w+)\/schedule$/.exec(path);
  if (schedule !== null && method === "GET") return json(SCHEDULES[schedule[1] ?? ""]);
  if (path.startsWith("/api/schedule/range")) return json({ days: weekFrom(new URL(path, "http://x").searchParams.get("from") ?? "") });
  return json({}, 200);
}

const ADMIN = {
  user: { id: "u1", fullName: "Admin", phoneE164: "+201000000000", email: null, locale: null },
  membershipId: "m-admin",
  tenantId: "t1",
  currency: "EGP",
  role: "ADMIN",
  memberships: [{ membershipId: "m-admin", tenantId: "t1", tenantName: "Nile Clinic", tenantSlug: "nile", role: "ADMIN" }],
  permissions: { "doctorSchedules.manage": "full" },
};
let me: Record<string, unknown> = ADMIN;

vi.mock("../auth/session.tsx", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../auth/session.tsx");
  return { ...actual, useSession: () => ({ authFetch: api, me }) };
});

const gets = (path: string) => calls.filter((call) => call.method === "GET" && call.path === path).length;
const doctorLine = (d: (typeof DOCTORS)[number]) => `${d.title} ${d.fullName} — ${d.specialty}`;

function renderPage() {
  return render(
    <LocaleProvider>
      <SchedulesPage />
    </LocaleProvider>,
  );
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-26T09:00:00Z"));
  calls = [];
  overrides = {};
  me = ADMIN;
  vi.mocked(downloadCsv).mockClear();
  vi.mocked(downloadFile).mockClear();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("the schedule editor, characterised before the split", () => {
  test("an admin gets a picker, the first doctor, and that doctor's week from Saturday", async () => {
    renderPage();
    await waitFor(() => expect(gets("/api/doctors/d1/schedule")).toBe(1));
    expect(gets("/api/schedule/range?doctorId=d1&from=2026-10-24&to=2026-10-30")).toBeGreaterThan(0);
    expect(screen.getByLabelText(t("schedules.doctor.label"))).toBeTruthy();
    // A doctor with saved hours opens with the settings collapsed.
    const toggle = await screen.findByRole("button", { name: t("schedules.settings.open") });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("button", { name: t("schedules.pattern.save") })).toBeNull();
    expect(await screen.findByRole("button", { name: t("schedules.exceptions.remove") })).toBeTruthy();
  });

  test("a doctor is pinned to their own schedule, shown as a label, and a first-time doctor gets the settings open", async () => {
    me = { ...ADMIN, role: "DOCTOR", membershipId: "m2", permissions: { "doctorSchedules.manage": "own" } };
    renderPage();
    await waitFor(() => expect(gets("/api/doctors/d2/schedule")).toBe(1));
    expect(gets("/api/doctors/d1/schedule")).toBe(0);
    expect(screen.queryByLabelText(t("schedules.doctor.label"))).toBeNull();
    expect(screen.getAllByText(doctorLine(DOCTORS[1]!)).length).toBeGreaterThan(0);
    expect(await screen.findByText(t("schedules.settings.firstTime"))).toBeTruthy();
  });

  test("switching doctor loads the other schedule", async () => {
    renderPage();
    await waitFor(() => expect(gets("/api/doctors/d1/schedule")).toBe(1));
    fireEvent.change(screen.getByLabelText(t("schedules.doctor.label")), { target: { value: "d2" } });
    await waitFor(() => expect(gets("/api/doctors/d2/schedule")).toBe(1));
    expect(await screen.findByText(t("schedules.settings.firstTime"))).toBeTruthy();
  });

  test("turning Thursday off and saving sends the week without it, then reloads", async () => {
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: t("schedules.settings.open") }));
    const thursday = (await screen.findAllByRole("button", { name: t("schedules.weekday.4" as TranslationKey) })).find(
      (button) => button.hasAttribute("aria-pressed"),
    );
    fireEvent.click(thursday!);
    fireEvent.click(screen.getByRole("button", { name: t("schedules.pattern.save") }));
    await waitFor(() => expect(calls.some((call) => call.method === "PUT")).toBe(true));
    const put = calls.find((call) => call.method === "PUT")!;
    expect(put.path).toBe("/api/doctors/d1/schedule/templates");
    const sent = (put.body as { templates: { weekday: number; startTime: string; endTime: string }[] }).templates;
    expect(sent.map((row) => row.weekday).sort()).toEqual([0, 1, 2, 3, 6]);
    expect(new Set(sent.map((row) => `${row.startTime}-${row.endTime}`))).toEqual(new Set(["09:00-17:00"]));
    await waitFor(() => expect(gets("/api/doctors/d1/schedule")).toBe(2));
  });

  test("removing an exception deletes it and reloads", async () => {
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: t("schedules.exceptions.remove") }));
    await waitFor(() =>
      expect(calls.some((call) => call.method === "DELETE" && call.path === "/api/doctors/d1/schedule/exceptions/e1")).toBe(true),
    );
    await waitFor(() => expect(gets("/api/doctors/d1/schedule")).toBe(2));
  });

  test("next week asks for the following Saturday to Friday", async () => {
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: t("schedules.week.next") }));
    await waitFor(() => expect(gets("/api/schedule/range?doctorId=d1&from=2026-10-31&to=2026-11-06")).toBeGreaterThan(0));
  });

  test("a schedule the caller may not read renders read-only: no exceptions, no spreadsheet", async () => {
    overrides = { "GET /api/doctors/d1/schedule": () => json({ code: "NOT_FOUND" }, 404) };
    renderPage();
    await waitFor(() => expect(gets("/api/doctors/d1/schedule")).toBe(1));
    await waitFor(() => expect(screen.getByRole("button", { name: t("schedules.export.spreadsheet") }).hasAttribute("disabled")).toBe(true));
    expect(screen.queryByText(t("schedules.exceptions.title"))).toBeNull();
  });

  test("the spreadsheet and calendar exports name the doctor, the hours and the week", async () => {
    renderPage();
    const spreadsheet = await screen.findByRole("button", { name: t("schedules.export.spreadsheet") });
    await waitFor(() => expect(spreadsheet.hasAttribute("disabled")).toBe(false));
    fireEvent.click(spreadsheet);
    const [csvName, csv] = vi.mocked(downloadCsv).mock.calls[0]!;
    expect(csvName).toBe(`${t("schedules.export.filename")}-Amal Hassan-2026-10-26.csv`);
    expect(csv).toContain("09:00");
    expect(csv).toContain("Nile Clinic");

    fireEvent.click(screen.getByRole("button", { name: t("schedules.export.calendarFile") }));
    const [icsName, , type] = vi.mocked(downloadFile).mock.calls[0]!;
    expect(icsName).toBe(`${t("schedules.export.filename")}-2026-10-24.ics`);
    expect(type).toBe("text/calendar;charset=utf-8");
  });

  test("a failed doctor list says so, and an empty one says there are no doctors", async () => {
    overrides = { "GET /api/doctors": () => json({}, 500) };
    const failed = renderPage();
    expect((await screen.findAllByText(t("schedules.loadFailed"))).length).toBeGreaterThan(0);
    failed.unmount();

    overrides = { "GET /api/doctors": () => json([]) };
    renderPage();
    expect(await screen.findByText(t("schedules.noDoctors.title"))).toBeTruthy();
  });
});
