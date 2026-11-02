// Characterises the queue board as it behaves today: what it asks for, what each role is offered,
// what an action sends, and how it polls. Written before splitting the file, so the split can fail.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ToastProvider } from "../../design-system/Toast.tsx";
import { LocaleProvider } from "../../i18n/locale-context.tsx";
import { intlLocale } from "../../i18n/format.ts";
import { DEFAULT_LOCALE } from "../../i18n/locale.ts";
import { t, type TranslationKey } from "../../i18n/strings.ts";
import { QUEUE_POLL_MS } from "../../lib/polling.ts";
import { openVisit } from "../visits/open-visit.ts";
import { QueuePage } from "./QueuePage.tsx";

vi.mock("../visits/open-visit.ts", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../visits/open-visit.ts");
  return { ...actual, openVisit: vi.fn() };
});

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

const entry = (id: string, doctorId: string, patientName: string, status: string, extra: Record<string, unknown> = {}) => ({
  appointmentId: id,
  patientId: `p-${id}`,
  patientName,
  coverage: { standing: "NONE" },
  doctorId,
  serviceId: "s1",
  status,
  scheduledStart: "2026-10-26T07:00:00Z",
  scheduledEnd: "2026-10-26T07:30:00Z",
  arrivedAt: null,
  waitingStartedAt: null,
  consultationStartedAt: null,
  waitedMs: null,
  isWalkIn: false,
  visitStatus: null,
  ...extra,
});

const ENTRIES = [
  entry("e1", "d1", "Sara Ali", "BOOKED"),
  entry("e2", "d1", "Hany Fouad", "CONFIRMED", { coverage: { standing: "LAPSED", insurerName: "MedRight" }, visitStatus: "COMPLETED" }),
  entry("e3", "d1", "Mona Adel", "ARRIVED", { coverage: { standing: "COVERED", insurerName: "Nile Care" }, waitedMs: 12 * 60_000, isWalkIn: true }),
  entry("e4", "d2", "Karim Nabil", "IN_CONSULTATION", { coverage: undefined, visitStatus: "DRAFT" }),
  entry("e5", "d2", "Laila Samir", "PAUSED"),
  entry("e6", "d-gone", "Nour Hamed", "BOOKED"),
];

const CANDIDATES = [
  { appointmentId: "e1", patientId: "p-e1", patientName: "Sara Ali", doctorId: "d1", scheduledStart: "2026-10-26T07:00:00Z", eligibleSince: "2026-10-26T07:15:00Z" },
  { appointmentId: "x9", patientId: "p-x9", patientName: "Ghost Patient", doctorId: "d1", scheduledStart: "2026-10-26T07:00:00Z", eligibleSince: "2026-10-26T07:15:00Z" },
];

const transfer = (id: string, appointmentId: string, patientName: string, status: string, decisionNote: string | null = null) => ({
  id,
  patientId: `p-${appointmentId}`,
  patientName,
  fromDoctorId: "d1",
  fromDoctorName: "Dr. Amal Hassan",
  toDoctorId: "d2",
  toDoctorName: "Dr. Omar Said",
  appointmentId,
  status,
  reason: null,
  decisionNote,
  requestedAt: "2026-10-26T08:00:00Z",
  decidedAt: null,
});

const TRANSFERS = [transfer("t1", "e3", "Mona Adel", "PENDING"), transfer("t2", "e2", "Hany Fouad", "REJECTED", "list is full")];

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

type Call = { path: string; method: string; body: unknown };
let calls: Call[] = [];
let overrides: Record<string, () => Response> = {};
let entries: unknown[] = ENTRIES;
let candidates: unknown[] = CANDIDATES;
let transfers: unknown[] = TRANSFERS;

async function api(path: string, init?: RequestInit): Promise<Response> {
  const method = init?.method ?? "GET";
  calls.push({ path, method, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
  const override = overrides[`${method} ${path.split("?")[0]}`];
  if (override !== undefined) return override();
  if (path === "/api/doctors") return json(DOCTORS);
  if (path.startsWith("/api/queue/today")) return json({ date: "2026-10-26", entries });
  if (path.startsWith("/api/no-shows/pending")) return json({ candidates });
  if (path.startsWith("/api/transfers")) return json({ transfers });
  return json({}, 200);
}

const permissions = (granted: string[]) =>
  Object.fromEntries(
    [
      "appointments.queueActions",
      "appointments.completeVisit",
      "appointments.write",
      "visits.write",
      "patients.transfer",
      "patients.transfer.read",
    ].map((key) => [key, granted.includes(key) ? "full" : "none"]),
  );

const member = (role: string, membershipId: string, granted: string[]) => ({
  user: { id: "u1", fullName: "Staff", phoneE164: "+201000000000", email: null, locale: null },
  membershipId,
  tenantId: "t1",
  currency: "EGP",
  role,
  memberships: [{ membershipId, tenantId: "t1", tenantName: "Nile Clinic", tenantSlug: "nile", role }],
  permissions: permissions(granted),
});

const RECEPTION = member("RECEPTIONIST", "m-desk", ["appointments.queueActions", "appointments.write", "patients.transfer", "patients.transfer.read"]);
const DOCTOR = member("DOCTOR", "m2", ["appointments.completeVisit", "appointments.write", "visits.write", "patients.transfer", "patients.transfer.read"]);
const OWNER = member("OWNER", "m-owner", []);
let me: Record<string, unknown> = RECEPTION;

vi.mock("../auth/session.tsx", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../auth/session.tsx");
  return { ...actual, useSession: () => ({ authFetch: api, me }) };
});

const queueLoads = () => calls.filter((call) => call.path.startsWith("/api/queue/today")).length;
const label = (key: string) => t(key as TranslationKey);
/** The queue row whose patient-name button reads `name`. */
const row = (name: string) => screen.getByRole("button", { name }).closest("li") as HTMLElement;
/** The no-show row for `name`: the list item holding a confirm button. */
const noShowRow = (name: string) =>
  screen
    .getAllByText(name)
    .map((node) => node.closest("li") as HTMLElement)
    .find((li) => within(li).queryByRole("button", { name: label("queue.noShow.confirm") }) !== null)!;
const clock = (iso: string) =>
  new Date(iso).toLocaleTimeString(intlLocale(DEFAULT_LOCALE), { hour: "2-digit", minute: "2-digit", hour12: false });

let visibility: DocumentVisibilityState = "visible";

function renderPage() {
  return render(
    <LocaleProvider>
      <ToastProvider>
        <QueuePage />
      </ToastProvider>
    </LocaleProvider>,
  );
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-26T09:00:00Z"));
  calls = [];
  overrides = {};
  entries = ENTRIES;
  candidates = CANDIDATES;
  transfers = TRANSFERS;
  me = RECEPTION;
  visibility = "visible";
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
  vi.mocked(openVisit).mockClear();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("the queue board, characterised before the split", () => {
  test("reception loads today's queue, no-shows and every transfer, grouped by doctor", async () => {
    renderPage();
    await screen.findByRole("button", { name: "Sara Ali" });
    const paths = calls.map((call) => call.path);
    expect(paths).toContain("/api/queue/today?date=2026-10-26");
    expect(paths).toContain("/api/no-shows/pending?date=2026-10-26");
    expect(paths).toContain("/api/transfers?openOnly=false");
    const titles = screen.getAllByRole("heading").map((heading) => heading.textContent);
    expect(titles).toEqual(expect.arrayContaining(["Dr. Amal Hassan", "Dr. Omar Said", label("queue.noDoctor")]));
    expect(screen.getByRole("button", { name: label("booking.action") })).toBeTruthy();
  });

  test("an owner never asks for transfers, still gets the board, and is offered no action", async () => {
    me = OWNER;
    renderPage();
    await screen.findByRole("button", { name: "Sara Ali" });
    expect(calls.some((call) => call.path.startsWith("/api/transfers"))).toBe(false);
    for (const key of ["queue.action.checkIn", "queue.action.start", "queue.action.complete", "queue.action.resume", "transfer.action", "booking.action"]) {
      expect(screen.queryByRole("button", { name: label(key) })).toBeNull();
    }
    expect(screen.queryByText(label("transfer.pending.title"))).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  test("reception may check in, and is offered nothing once the patient has arrived", async () => {
    renderPage();
    await screen.findByRole("button", { name: "Sara Ali" });
    expect(within(row("Sara Ali")).getByRole("button", { name: label("queue.action.checkIn") })).toBeTruthy();
    expect(within(row("Hany Fouad")).getByRole("button", { name: label("queue.action.checkIn") })).toBeTruthy();
    expect(within(row("Mona Adel")).queryByRole("button", { name: label("queue.action.start") })).toBeNull();
    expect(within(row("Karim Nabil")).queryByRole("button", { name: label("queue.action.complete") })).toBeNull();
    expect(within(row("Karim Nabil")).queryByRole("button", { name: label("queue.action.openVisit") })).toBeNull();
    expect(within(row("Laila Samir")).queryByRole("button", { name: label("queue.action.resume") })).toBeNull();
  });

  test("a doctor may start, complete, resume and reopen a visit, and start opens the record", async () => {
    me = DOCTOR;
    renderPage();
    await screen.findByRole("button", { name: "Sara Ali" });
    expect(within(row("Sara Ali")).queryByRole("button", { name: label("queue.action.checkIn") })).toBeNull();
    expect(within(row("Karim Nabil")).getByRole("button", { name: label("queue.action.complete") })).toBeTruthy();
    expect(within(row("Laila Samir")).getByRole("button", { name: label("queue.action.resume") })).toBeTruthy();

    fireEvent.click(within(row("Karim Nabil")).getByRole("button", { name: label("queue.action.openVisit") }));
    expect(openVisit).toHaveBeenCalledWith("e4");

    fireEvent.click(within(row("Mona Adel")).getByRole("button", { name: label("queue.action.start") }));
    await waitFor(() => expect(openVisit).toHaveBeenCalledWith("e3"));
    expect(calls.find((call) => call.method === "PATCH")).toEqual({ path: "/api/queue/e3/start", method: "PATCH", body: { expectedStatus: "ARRIVED" } });
  });

  test("an action sends the status on screen, then refreshes the board", async () => {
    renderPage();
    await screen.findByRole("button", { name: "Hany Fouad" });
    const before = queueLoads();
    fireEvent.click(within(row("Hany Fouad")).getByRole("button", { name: label("queue.action.checkIn") }));
    await waitFor(() => expect(queueLoads()).toBe(before + 1));
    expect(calls.find((call) => call.method === "PATCH")).toEqual({ path: "/api/queue/e2/check-in", method: "PATCH", body: { expectedStatus: "CONFIRMED" } });
    expect(openVisit).not.toHaveBeenCalled();
  });

  test("a refusal is said as a sentence naming the doctor, and the board still refreshes", async () => {
    overrides["PATCH /api/queue/e1/check-in"] = () => json({ reason: "QUEUE_MOVED_ON", currentStatus: "IN_CONSULTATION" }, 409);
    renderPage();
    await screen.findByRole("button", { name: "Sara Ali" });
    const before = queueLoads();
    fireEvent.click(within(row("Sara Ali")).getByRole("button", { name: label("queue.action.checkIn") }));
    const sentence = `${label("queue.moved.IN_CONSULTATION").replace("{doctor}", "Dr. Amal Hassan")} — ${label("queue.refusal.suffix")}`;
    expect(await screen.findByText(sentence)).toBeTruthy();
    await waitFor(() => expect(queueLoads()).toBe(before + 1));
  });

  test("each row shows its cover, visit, walk-in and waiting state", async () => {
    renderPage();
    await screen.findByRole("button", { name: "Sara Ali" });
    const sara = within(row("Sara Ali"));
    expect(sara.getByText(label("queue.cover.none"))).toBeTruthy();
    expect(sara.getByText(label("queue.notArrived"), { exact: false })).toBeTruthy();
    expect(sara.getByText(clock("2026-10-26T07:00:00Z"))).toBeTruthy();

    const hany = row("Hany Fouad");
    expect(within(hany).getByText("MedRight")).toBeTruthy();
    expect(within(hany).getByText(label("queue.cover.lapsed"), { exact: false })).toBeTruthy();
    expect(within(hany).getByTestId("visit-status-badge").getAttribute("data-visit-status")).toBe("COMPLETED");

    const mona = within(row("Mona Adel"));
    expect(mona.getByText("Nile Care")).toBeTruthy();
    expect(mona.getByText(label("queue.cover.covered"), { exact: false })).toBeTruthy();
    expect(mona.getByText(label("queue.walkIn"))).toBeTruthy();
    expect(mona.getByText(label("queue.waitingFor").replace("{minutes}", "12"), { exact: false })).toBeTruthy();

    // No coverage field at all renders no cover badge, rather than inventing "no insurance".
    const karim = row("Karim Nabil");
    for (const key of ["queue.cover.none", "queue.cover.lapsed", "queue.cover.covered"]) {
      expect(within(karim).queryByText(label(key), { exact: false })).toBeNull();
    }
    expect(within(karim).getByTestId("visit-status-badge").getAttribute("data-visit-status")).toBe("DRAFT");
    expect(within(row("Laila Samir")).queryByTestId("visit-status-badge")).toBeNull();
    expect(screen.getAllByText(label("queue.walkIn"))).toHaveLength(1);
  });

  test("the patient's name opens the detail panel, and a change there refreshes the board", async () => {
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Laila Samir" }));
    expect(screen.getByTestId("panel").textContent).toContain("e5");
    const before = queueLoads();
    fireEvent.click(screen.getByRole("button", { name: "panel-changed" }));
    await waitFor(() => expect(queueLoads()).toBe(before + 1));
  });

  test("a pending transfer badges its row and hides its button; a rejection stays until dismissed", async () => {
    renderPage();
    await screen.findByRole("button", { name: "Mona Adel" });
    expect(screen.getByText(label("transfer.pending.title"))).toBeTruthy();
    const mona = row("Mona Adel");
    expect(within(mona).getByTitle(label("transfer.badge.title").replace("{doctor}", "Dr. Omar Said"))).toBeTruthy();
    expect(within(mona).queryByRole("button", { name: label("transfer.action") })).toBeNull();

    const banner = screen.getByRole("alert");
    expect(banner.textContent).toContain("Hany Fouad");
    expect(banner.textContent).toContain("list is full");
    fireEvent.click(within(banner).getByRole("button", { name: label("transfer.rejectedBanner.dismiss") }));
    expect(screen.queryByRole("alert")).toBeNull();

    fireEvent.click(within(row("Sara Ali")).getByRole("button", { name: label("transfer.action") }));
    expect(await screen.findByText(label("transfer.request.title"))).toBeTruthy();
  });

  test("a dismissed rejection stays dismissed when the board refreshes", async () => {
    renderPage();
    fireEvent.click(within(await screen.findByRole("alert")).getByRole("button", { name: label("transfer.rejectedBanner.dismiss") }));
    const before = queueLoads();
    fireEvent.click(screen.getByRole("button", { name: "panel-changed" }));
    await waitFor(() => expect(queueLoads()).toBe(before + 1));
    await waitFor(() => expect(calls.filter((call) => call.path.startsWith("/api/transfers")).length).toBe(2));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  test("after a dismissal, a rejection that is new still reaches reception", async () => {
    renderPage();
    fireEvent.click(within(await screen.findByRole("alert")).getByRole("button", { name: label("transfer.rejectedBanner.dismiss") }));
    transfers = [...TRANSFERS, transfer("t3", "e1", "Sara Ali", "REJECTED", "no capacity")];
    fireEvent.click(screen.getByRole("button", { name: "panel-changed" }));
    const banner = await screen.findByRole("alert");
    expect(banner.textContent).toContain("Sara Ali");
    expect(screen.getAllByRole("alert")).toHaveLength(1);
  });

  test("a no-show is confirmed one row at a time, and a candidate off the board cannot be", async () => {
    renderPage();
    await screen.findByText(label("queue.noShow.warning"));
    expect(within(noShowRow("Ghost Patient")).getByRole("button", { name: label("queue.noShow.confirm") }).hasAttribute("disabled")).toBe(true);
    expect(within(noShowRow("Sara Ali")).getByText(label("queue.noShow.since").replace("{time}", clock("2026-10-26T07:15:00Z")))).toBeTruthy();
    fireEvent.click(within(noShowRow("Sara Ali")).getByRole("button", { name: label("queue.noShow.confirm") }));
    await waitFor(() =>
      expect(calls.find((call) => call.method === "PATCH")).toEqual({ path: "/api/queue/e1/no-show", method: "PATCH", body: { expectedStatus: "BOOKED" } }),
    );
  });

  test("an empty day and an empty no-show list each say so", async () => {
    entries = [];
    candidates = [];
    renderPage();
    expect(await screen.findByText(label("queue.empty.title"))).toBeTruthy();
    expect(screen.getByText(label("queue.noShow.empty"))).toBeTruthy();
    expect(screen.queryByText(label("queue.noShow.warning"))).toBeNull();
  });

  test("a failed load offers a retry that brings the board back", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    overrides["GET /api/queue/today"] = () => json({}, 500);
    renderPage();
    const retry = await screen.findByRole("button", { name: label("queue.retry") });
    expect(screen.getByText(label("queue.loadFailed"))).toBeTruthy();
    delete overrides["GET /api/queue/today"];
    fireEvent.click(retry);
    expect(await screen.findByRole("button", { name: "Sara Ali" })).toBeTruthy();
  });

  test("it polls every QUEUE_POLL_MS while visible, stops when hidden, and refetches on return", async () => {
    const original = window.setInterval.bind(window);
    let tick: (() => void) | null = null;
    const setSpy = vi.spyOn(window, "setInterval").mockImplementation(((handler: () => void, ms?: number) => {
      if (ms !== QUEUE_POLL_MS) return original(handler, ms);
      tick = handler;
      return 4242;
    }) as typeof window.setInterval);
    const clearSpy = vi.spyOn(window, "clearInterval");

    renderPage();
    await screen.findByRole("button", { name: "Sara Ali" });
    expect(tick).not.toBeNull();
    const before = queueLoads();
    await act(async () => tick!());
    await waitFor(() => expect(queueLoads()).toBe(before + 1));

    visibility = "hidden";
    act(() => void document.dispatchEvent(new Event("visibilitychange")));
    expect(clearSpy).toHaveBeenCalledWith(4242);
    const pollsSet = setSpy.mock.calls.filter(([, ms]) => ms === QUEUE_POLL_MS).length;

    visibility = "visible";
    act(() => void document.dispatchEvent(new Event("visibilitychange")));
    await waitFor(() => expect(queueLoads()).toBe(before + 2));
    expect(setSpy.mock.calls.filter(([, ms]) => ms === QUEUE_POLL_MS).length).toBe(pollsSet + 1);
  });
});
