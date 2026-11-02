// Characterises the day view as it behaves today: whose day it loads, how the bar reads, what opens.
// Written before splitting the file, so the split has something that can fail if behaviour moves.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { LocaleProvider } from "../../i18n/locale-context.tsx";
import { intlLocale } from "../../i18n/format.ts";
import { DEFAULT_LOCALE } from "../../i18n/locale.ts";
import { t, type TranslationKey } from "../../i18n/strings.ts";
import { DISPLAY_TIME_ZONE } from "../../lib/clinic-time-zone.ts";
import { DayViewPage } from "./DayViewPage.tsx";

vi.mock("../appointment-detail/AppointmentDetailPanel.tsx", () => ({
  AppointmentDetailPanel: ({ appointmentId, onChanged }: { appointmentId: string | null; onChanged: () => void }) => (
    <div data-testid="panel">
      {appointmentId ?? "closed"}
      <button type="button" onClick={onChanged}>
        panel-changed
      </button>
    </div>
  ),
}));

const DOCTORS = [
  { id: "d1", membershipId: "m1", fullName: "Amal Hassan", title: "Dr.", specialty: "Dermatology", licenseNumber: "1", isActive: true },
  { id: "d2", membershipId: "m2", fullName: "Omar Said", title: "Dr.", specialty: "Paediatrics", licenseNumber: "2", isActive: true },
];

const window_ = (start: string, end: string) => ({ start, end, utcOffsetMinutes: 180 });

/** 2026-10-26: 08:00–12:00Z with a 10:00–10:30 break, two appointments, three free stretches. */
const WORKING_DAY = {
  date: "2026-10-26",
  doctorId: "d1",
  working: [window_("2026-10-26T08:00:00Z", "2026-10-26T10:00:00Z"), window_("2026-10-26T10:30:00Z", "2026-10-26T12:00:00Z")],
  busy: [
    { start: "2026-10-26T08:00:00Z", end: "2026-10-26T08:30:00Z", appointmentId: "a1", status: "CONFIRMED" },
    { start: "2026-10-26T09:00:00Z", end: "2026-10-26T09:30:00Z", appointmentId: "a2", status: "ARRIVED" },
  ],
  free: [
    { start: "2026-10-26T08:30:00Z", end: "2026-10-26T09:00:00Z" },
    { start: "2026-10-26T09:30:00Z", end: "2026-10-26T10:00:00Z" },
    { start: "2026-10-26T10:30:00Z", end: "2026-10-26T12:00:00Z" },
  ],
  unavailable: [{ start: "2026-10-26T10:00:00Z", end: "2026-10-26T10:30:00Z" }],
  fullyBooked: false,
};

/** 2026-10-27, Cairo 22:00 to 02:00: the same UTC date, two clinic dates. No breaks. */
const NIGHT_DAY = {
  date: "2026-10-27",
  doctorId: "d1",
  working: [window_("2026-10-27T19:00:00Z", "2026-10-27T23:00:00Z")],
  busy: [],
  free: [{ start: "2026-10-27T19:00:00Z", end: "2026-10-27T23:00:00Z" }],
  unavailable: [],
  fullyBooked: false,
};

const emptyDay = (date: string, doctorId: string) => ({
  date,
  doctorId,
  working: [],
  busy: [],
  free: [],
  unavailable: [],
  fullyBooked: false,
});

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let paths: string[] = [];
let doctors: unknown = DOCTORS;
let days: Record<string, unknown> = {};
let dayStatus = 200;

async function api(path: string): Promise<Response> {
  paths.push(path);
  if (path === "/api/doctors") return json(doctors);
  const url = new URL(path, "http://x");
  if (url.pathname === "/api/schedule/day") {
    if (dayStatus !== 200) return json({}, dayStatus);
    const doctorId = url.searchParams.get("doctorId") ?? "";
    const date = url.searchParams.get("date") ?? "";
    return json(days[`${doctorId} ${date}`] ?? emptyDay(date, doctorId));
  }
  return json({}, 200);
}

const ADMIN = {
  user: { id: "u1", fullName: "Admin", phoneE164: "+201000000000", email: null, locale: null },
  membershipId: "m-admin",
  tenantId: "t1",
  currency: "EGP",
  role: "RECEPTIONIST",
  memberships: [{ membershipId: "m-admin", tenantId: "t1", tenantName: "Nile Clinic", tenantSlug: "nile", role: "RECEPTIONIST" }],
  permissions: {},
};
let me: Record<string, unknown> = ADMIN;

vi.mock("../auth/session.tsx", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../auth/session.tsx");
  return { ...actual, useSession: () => ({ authFetch: api, me }) };
});

const dayPath = (doctorId: string, date: string) => `/api/schedule/day?doctorId=${doctorId}&date=${date}`;
const loads = (doctorId: string, date: string) => paths.filter((path) => path === dayPath(doctorId, date)).length;
const dayLoads = () => paths.filter((path) => path.startsWith("/api/schedule/day")).length;
const status = (s: string) => t(`appointment.status.${s}` as TranslationKey);
const clock = (iso: string) =>
  new Intl.DateTimeFormat(intlLocale(DEFAULT_LOCALE), { timeZone: DISPLAY_TIME_ZONE, hour: "2-digit", minute: "2-digit", hour12: false }).format(
    new Date(iso),
  );

function renderPage() {
  return render(
    <LocaleProvider>
      <DayViewPage />
    </LocaleProvider>,
  );
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-26T09:10:00Z"));
  paths = [];
  doctors = DOCTORS;
  days = { "d1 2026-10-26": WORKING_DAY, "d1 2026-10-27": NIGHT_DAY };
  dayStatus = 200;
  me = ADMIN;
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("the day view, characterised before the split", () => {
  test("reception gets a picker, the first doctor, and today; changing doctor or date reloads", async () => {
    renderPage();
    await waitFor(() => expect(loads("d1", "2026-10-26")).toBe(1));
    const picker = screen.getByLabelText(t("day.doctor")) as HTMLSelectElement;
    expect([...picker.options].map((o) => o.value)).toEqual(["d1", "d2"]);
    expect(picker.value).toBe("d1");

    fireEvent.change(picker, { target: { value: "d2" } });
    await waitFor(() => expect(loads("d2", "2026-10-26")).toBe(1));
    fireEvent.change(screen.getByLabelText(t("day.date")), { target: { value: "2026-11-03" } });
    await waitFor(() => expect(loads("d2", "2026-11-03")).toBe(1));
  });

  test("a doctor is pinned to their own day and shown a label, not a picker", async () => {
    me = { ...ADMIN, role: "DOCTOR", membershipId: "m2" };
    renderPage();
    await waitFor(() => expect(loads("d2", "2026-10-26")).toBe(1));
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.getByText("Dr. Omar Said — Paediatrics")).toBeTruthy();
    expect(loads("d1", "2026-10-26")).toBe(0);
  });

  test("a doctor with no doctor row loads nobody's day rather than the first doctor's", async () => {
    me = { ...ADMIN, role: "DOCTOR", membershipId: "m-archived" };
    renderPage();
    await screen.findByText("—");
    expect(dayLoads()).toBe(0);
  });

  test("previous, next and today move the date one day at a time", async () => {
    renderPage();
    await waitFor(() => expect(loads("d1", "2026-10-26")).toBe(1));
    fireEvent.click(screen.getByRole("button", { name: t("day.next") }));
    await waitFor(() => expect(loads("d1", "2026-10-27")).toBe(1));
    fireEvent.click(screen.getByRole("button", { name: t("day.prev") }));
    await waitFor(() => expect(loads("d1", "2026-10-26")).toBe(2));
    fireEvent.click(screen.getByRole("button", { name: t("day.prev") }));
    await waitFor(() => expect(loads("d1", "2026-10-25")).toBe(1));
    fireEvent.click(screen.getByRole("button", { name: t("day.today") }));
    await waitFor(() => expect(loads("d1", "2026-10-26")).toBe(3));
  });

  test("no doctors, a failed load, and a day off each get their own empty state", async () => {
    doctors = [];
    renderPage();
    expect((await screen.findAllByText(t("day.noDoctors"))).length).toBe(2);
    cleanup();

    doctors = DOCTORS;
    dayStatus = 500;
    renderPage();
    expect((await screen.findAllByText(t("day.loadFailed"))).length).toBe(2);
    cleanup();

    dayStatus = 200;
    days = {};
    renderPage();
    expect(await screen.findByText(t("day.notWorking.title"))).toBeTruthy();
    expect(screen.queryByText(t("day.fullyBooked.title"))).toBeNull();
  });

  test("a fully booked day says so, and is not mistaken for a day off", async () => {
    days = { "d1 2026-10-26": { ...WORKING_DAY, free: [], fullyBooked: true } };
    renderPage();
    expect(await screen.findByText(t("day.fullyBooked.title"))).toBeTruthy();
    expect(screen.queryByText(t("day.notWorking.title"))).toBeNull();
  });

  test("the bar spans the session, ticks whole hours, and its blocks open the detail panel", async () => {
    renderPage();
    expect(await screen.findByText(`${clock("2026-10-26T08:00:00Z")} – ${clock("2026-10-26T12:00:00Z")}`)).toBeTruthy();
    expect(screen.queryByText(t("day.crossesMidnight"), { exact: false })).toBeNull();
    // 10:00Z and 11:00Z appear only as hour labels; the session's end is not a tick.
    expect(screen.getAllByText(clock("2026-10-26T10:00:00Z"))).toHaveLength(1);
    expect(screen.getAllByText(clock("2026-10-26T11:00:00Z"))).toHaveLength(1);
    expect(screen.getAllByText(clock("2026-10-26T12:00:00Z"))).toHaveLength(1);

    expect(screen.getByTestId("panel").textContent).toContain("closed");
    fireEvent.click(screen.getByRole("button", { name: `${clock("2026-10-26T09:00:00Z")} — ${status("ARRIVED")}` }));
    expect(screen.getByTestId("panel").textContent).toContain("a2");

    const before = loads("d1", "2026-10-26");
    fireEvent.click(screen.getByRole("button", { name: "panel-changed" }));
    await waitFor(() => expect(loads("d1", "2026-10-26")).toBe(before + 1));
  });

  test("the legend lists only the statuses present, the free count, breaks, and now", async () => {
    renderPage();
    await screen.findByText(t("day.summary.free").replace("{n}", "3"));
    // CONFIRMED and ARRIVED: once in the legend, once on the list badge.
    expect(screen.getAllByText(status("CONFIRMED"))).toHaveLength(2);
    expect(screen.getAllByText(status("ARRIVED"))).toHaveLength(2);
    expect(screen.queryByText(status("BOOKED"))).toBeNull();
    expect(screen.getByText(t("day.unavailable"))).toBeTruthy();
    expect(screen.getByText(t("day.now"))).toBeTruthy();
  });

  test("a night session reads as one band past midnight, with no now marker on another day", async () => {
    renderPage();
    await waitFor(() => expect(loads("d1", "2026-10-26")).toBe(1));
    fireEvent.click(screen.getByRole("button", { name: t("day.next") }));
    expect(await screen.findByText(t("day.crossesMidnight"), { exact: false })).toBeTruthy();
    expect(screen.getByText(`${clock("2026-10-27T19:00:00Z")} – ${clock("2026-10-27T23:00:00Z")}`)).toBeTruthy();
    expect(screen.queryByText(t("day.now"))).toBeNull();
    expect(screen.queryByText(t("day.unavailable"))).toBeNull();
    expect(screen.queryAllByRole("listitem")).toHaveLength(0);
  });

  test("the list shows each appointment's start, end and status", async () => {
    renderPage();
    const items = await screen.findAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(within(items[0]!).getByText(clock("2026-10-26T08:00:00Z"))).toBeTruthy();
    expect(within(items[0]!).getByText(`– ${clock("2026-10-26T08:30:00Z")}`)).toBeTruthy();
    expect(within(items[0]!).getByText(status("CONFIRMED"))).toBeTruthy();
    expect(within(items[1]!).getByText(`– ${clock("2026-10-26T09:30:00Z")}`)).toBeTruthy();
    expect(within(items[1]!).getByText(status("ARRIVED"))).toBeTruthy();
  });
});
