import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { LocaleProvider } from "../../i18n/locale-context.tsx";
import { SessionProvider, type CurrentUser } from "../auth/session.tsx";
import { AppointmentBookPage } from "./AppointmentBookPage.tsx";

/**
 * «المواعيد» — the appointment book. Phase 5 PR 13.
 *
 * The screen's half of the ruling: **a doctor sees their own days read-only and is offered no
 * doctor picker**, and **a move is a dialog rather than a drag**. The server's half — the state
 * machine, the exclusion constraint and the `own` scoping a hidden control cannot enforce — is
 * `appointment-book.integration.spec.ts` and `own-doctor-scoping.integration.spec.ts`.
 */

const ME: CurrentUser = {
  user: { id: "u1", fullName: "شيماء", phoneE164: "+201000000000", email: null, locale: null },
  membershipId: "m1",
  tenantId: "t1",
  currency: "EGP",
  role: "RECEPTIONIST",
  memberships: [],
  permissions: { "appointments.read": "full", "appointments.write": "full" },
};

const AS_DOCTOR: CurrentUser = { ...ME, role: "DOCTOR" };

const MONTH = {
  month: "2027-03",
  days: [{ date: "2027-03-04", total: 1, byDoctor: [{ doctorId: "d1", doctorName: "د. هشام", count: 1 }] }],
  doctors: [{ id: "d1", name: "د. هشام" }],
  readOnly: false,
};

const BOOKING = {
  appointmentId: "a1",
  patientName: "مريم حسن",
  doctorId: "d1",
  doctorName: "د. هشام",
  serviceId: "s1",
  serviceName: "كشف",
  startsAt: "2027-03-04T09:00:00.000Z",
  status: "BOOKED",
};

/** The drawer's spine. Offset zero so the hour labels are the UTC ones the fixtures are written in. */
/** Built for whichever date is asked for: a spine pinned to one day would place the hours of another
 * day hundreds of rows away from its own midnight. */
const timelineFor = (date: string) => ({
  date,
  doctorId: "d1",
  working: [{ start: `${date}T08:00:00.000Z`, end: `${date}T12:00:00.000Z`, utcOffsetMinutes: 0 }],
  busy: [{ start: `${date}T09:00:00.000Z`, end: `${date}T09:30:00.000Z`, appointmentId: "a1", status: "BOOKED" }],
  free: [{ start: `${date}T10:00:00.000Z`, end: `${date}T12:00:00.000Z` }],
  unavailable: [],
  fullyBooked: false,
});

const SLOTS = {
  slots: [
    { slotToken: "tok-1", startsAt: "2027-03-04T11:00:00.000Z", endsAt: "2027-03-04T11:30:00.000Z" },
    { slotToken: "tok-10", startsAt: "2027-03-04T10:00:00.000Z", endsAt: "2027-03-04T10:30:00.000Z" },
  ],
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function routes(month: unknown, bookings: unknown[], monthStatus = 200) {
  return async (input: RequestInfo | URL, _init?: RequestInit) => {
    const path = String(input);
    if (path.includes("/schedule/month")) return json(month, monthStatus);
    if (path.includes("/schedule/day/bookings")) return json({ bookings });
    // Checked after the bookings route: one path is a prefix of the other.
    if (path.includes("/schedule/day")) {
      return json(timelineFor(/date=(\d{4}-\d{2}-\d{2})/.exec(path)?.[1] ?? "2027-03-04"));
    }
    if (path.includes("/availability")) return json(SLOTS);
    if (path.includes("/services")) return json([{ id: "s1", nameAr: "كشف", nameEn: "Consult", isActive: true }]);
    if (path.includes("/patients")) return json([{ id: "p1", fullNameAr: "مريم حسن" }]);
    return json({});
  };
}

/**
 * The reader's clock is **the 1st**, so the fixture day (the 4th) is still ahead of them.
 *
 * It used to be the 15th, which made every booking and move test sit on a day that has passed — and
 * since 2026-09-13 those controls are gone there, correctly. The clock is a parameter rather than a
 * new fixture date because one instant decides it and seventeen date literals do not.
 */
function renderBook(
  month: unknown = MONTH,
  bookings: unknown[] = [BOOKING],
  me: CurrentUser = ME,
  now: Date = new Date("2027-03-01T09:00:00Z"),
) {
  const fetchMock = vi.fn(routes(month, bookings));
  vi.stubGlobal("fetch", fetchMock);
  render(
    <LocaleProvider>
      <SessionProvider initialToken="token" initialMe={me} onSignedOut={() => {}}>
        <AppointmentBookPage today={now} />
      </SessionProvider>
    </LocaleProvider>,
  );
  return fetchMock;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the appointment book", () => {
  test("a month asks for the month it is showing, and moving on asks for the next", async () => {
    const fetchMock = renderBook();
    await screen.findByTestId("month-grid");

    const shown = screen.getByTestId("current-month").textContent;
    fireEvent.click(screen.getByTestId("next-month"));
    await waitFor(() => expect(screen.getByTestId("current-month").textContent).not.toBe(shown));
    await waitFor(() => {
      const asked = fetchMock.mock.calls.map(([path]) => String(path)).filter((p) => p.includes("month="));
      expect(new Set(asked).size).toBeGreaterThan(1);
    });
  });

  test("a seeded month renders its counts on the days that have appointments", async () => {
    renderBook();
    // The bug this replaces: the DTO rejected every real month, the client turned the 400 into an
    // empty book, and every square rendered blank over a month that held 1266 appointments.
    const cell = await screen.findByTestId("day-2027-03-04");
    expect(cell.textContent).toContain("1");
    expect(cell.textContent).toContain("د. هشام");
    expect(screen.queryByTestId("book-failed")).toBeNull();
  });

  test("a refused month says so, and never that nothing is booked", async () => {
    renderBook(MONTH, [BOOKING], ME);
    cleanup();
    vi.unstubAllGlobals();
    vi.stubGlobal("fetch", vi.fn(routes(MONTH, [BOOKING], 400)));
    render(
      <LocaleProvider>
        <SessionProvider initialToken="token" initialMe={ME} onSignedOut={() => {}}>
          <AppointmentBookPage today={new Date("2027-03-15T09:00:00Z")} />
        </SessionProvider>
      </LocaleProvider>,
    );

    const alert = await screen.findByTestId("book-failed");
    expect(alert.textContent?.length ?? 0).toBeGreaterThan(5);
  });

  test("opening a day lays its bookings out by the hour", async () => {
    renderBook();
    await screen.findByTestId("month-grid");
    fireEvent.click(screen.getByTestId("day-2027-03-04"));

    const timeline = await screen.findByTestId("day-timeline");
    // The spine is the working day, not just the booked hours: 08:00 to 11:00 inclusive.
    expect(screen.getByTestId("hour-8")).toBeTruthy();
    expect(screen.getByTestId("hour-11")).toBeTruthy();

    // And the booking sits in its own hour, with the patient, the doctor and the status.
    const nine = screen.getByTestId("hour-9");
    expect(nine.textContent).toContain("مريم حسن");
    expect(nine.textContent).toContain("د. هشام");
    expect(timeline.textContent).toContain("09:00");
    expect(screen.getByTestId("booking-a1")).toBeTruthy();
  });

  test("a free hour offers a booking, and opens the dialog on that hour's slot", async () => {
    const fetchMock = renderBook();
    await screen.findByTestId("month-grid");
    fireEvent.click(screen.getByTestId("day-2027-03-04"));

    // 10:00 is free and 09:00 is not: the offer is where there is room.
    await screen.findByTestId("hour-10");
    expect(screen.queryByTestId("book-hour-9")).toBeNull();
    fireEvent.click(screen.getByTestId("book-hour-10"));

    // The slot at 10:00 is chosen, not the first one the engine happened to list.
    await waitFor(() => expect(screen.getByTestId("slot-2027-03-04T10:00:00.000Z").getAttribute("aria-pressed")).toBe("true"));
    expect(fetchMock.mock.calls.some(([path]) => String(path).includes("/availability"))).toBe(true);
  });

  test("a finished appointment shows in the day and is offered no move", async () => {
    const done = { ...BOOKING, appointmentId: "a9", status: "COMPLETED" };
    renderBook(MONTH, [done]);
    await screen.findByTestId("month-grid");
    fireEvent.click(screen.getByTestId("day-2027-03-04"));

    // It is there, because the month square counted it. And the screen asks the state machine
    // whether a move is legal rather than offering one the server would refuse.
    expect(await screen.findByTestId("booking-a9")).toBeTruthy();
    expect(screen.queryByTestId("move-a9")).toBeNull();
  });

  /**
   * **A day that has passed offers nothing to book or move** — ruled 2026-09-13.
   *
   * Whole days in the clinic's time: today keeps its controls until it ends. The API refuses a past
   * slot exactly, with `PAST_SLOT`; this is the coarser screen rule, and the two are deliberately
   * not the same granularity.
   */
  test("a past day shows no booking and no move, and says why", async () => {
    // The same fixture day, read from the 15th instead of the 1st: the 4th is now behind us.
    renderBook(MONTH, [BOOKING], ME, new Date("2027-03-15T09:00:00Z"));
    await screen.findByTestId("month-grid");
    fireEvent.click(screen.getByTestId("day-2027-03-04"));
    await screen.findByTestId("day-timeline");

    expect(screen.queryByTestId("new-booking")).toBeNull();
    expect(screen.queryByTestId("move-a1")).toBeNull();
    expect(screen.queryByTestId("book-hour-10")).toBeNull();
    // Said rather than left to be inferred from a missing button.
    expect((await screen.findByTestId("book-past-day")).textContent?.length ?? 0).toBeGreaterThan(5);
  });

  test("the same day, still ahead of the reader, offers both", async () => {
    // The control for the test above — one instant apart, nothing else changed.
    renderBook();
    await screen.findByTestId("month-grid");
    fireEvent.click(screen.getByTestId("day-2027-03-04"));
    await screen.findByTestId("day-timeline");

    expect(screen.getByTestId("new-booking")).toBeTruthy();
    expect(screen.getByTestId("move-a1")).toBeTruthy();
    expect(screen.getByTestId("book-hour-10")).toBeTruthy();
    expect(screen.queryByTestId("book-past-day")).toBeNull();
  });

  test("a doctor's own days are read-only: no booking, no move", async () => {
    renderBook({ ...MONTH, readOnly: true }, [BOOKING], AS_DOCTOR);
    await screen.findByTestId("month-grid");
    fireEvent.click(screen.getByTestId("day-2027-03-04"));

    await screen.findByTestId("book-read-only");
    // The ruling, on the screen: they see the day and are offered nothing to do to it.
    expect(screen.queryByTestId("new-booking")).toBeNull();
    expect(screen.queryByTestId("move-a1")).toBeNull();
    expect(screen.queryByTestId("book-hour-10")).toBeNull();
  });

  test("a doctor is offered no doctor picker, and asks for no colleague's days", async () => {
    const fetchMock = renderBook({ ...MONTH, readOnly: true }, [BOOKING], AS_DOCTOR);
    await screen.findByTestId("month-grid");
    fireEvent.click(screen.getByTestId("day-2027-03-04"));
    await screen.findByTestId("day-timeline");

    // The calendar is theirs. A picker of colleagues contradicts the `own` level the server pins
    // them to — and the server pins it either way, which own-doctor-scoping proves over HTTP.
    expect(screen.queryByTestId("doctor-filter")).toBeNull();

    const asked = fetchMock.mock.calls.map(([path]) => String(path));
    expect(asked.some((path) => path.includes("/schedule/month"))).toBe(true);
    expect(asked.every((path) => !path.includes("doctorId=d2"))).toBe(true);
  });

  test("reception keeps the picker", async () => {
    renderBook();
    expect(await screen.findByTestId("doctor-filter")).toBeTruthy();
  });

  test("a move opens a dialog and sends the slot token, never a time", async () => {
    const fetchMock = renderBook();
    await screen.findByTestId("month-grid");
    fireEvent.click(screen.getByTestId("day-2027-03-04"));
    fireEvent.click(await screen.findByTestId("move-a1"));

    // The appointment being moved is named, so nobody moves the wrong one.
    expect((await screen.findByTestId("moving-summary")).textContent).toContain("مريم حسن");

    fireEvent.click(await screen.findByTestId("slot-2027-03-04T11:00:00.000Z"));
    fireEvent.click(screen.getByTestId("confirm-slot"));

    await waitFor(() => {
      const patch = fetchMock.mock.calls.find(
        ([path, init]) =>
          String(path).includes("/reschedule") && (init as RequestInit | undefined)?.method === "PATCH",
      );
      expect(patch).toBeDefined();
      const body = JSON.parse((patch as [string, RequestInit])[1].body as string) as Record<string, unknown>;
      // **Only the token.** A `scheduledStart` on this request would be a screen naming a time, and
      // the slot engine and the exclusion constraint would have nothing to arbitrate.
      expect(body).toEqual({ slotToken: "tok-1" });
    });
  });

  test("a lost race is rendered as a sentence, and the slots are reloaded", async () => {
    const base = routes(MONTH, [BOOKING]);
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("/reschedule") && init?.method === "PATCH") {
        return json({ code: "SLOT_TAKEN", params: {} }, 409);
      }
      return base(input, init);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(
      <LocaleProvider>
        <SessionProvider initialToken="token" initialMe={ME} onSignedOut={() => {}}>
          {/* The 1st, like `renderBook`: a move needs a day that has not passed. */}
          <AppointmentBookPage today={new Date("2027-03-01T09:00:00Z")} />
        </SessionProvider>
      </LocaleProvider>,
    );

    await screen.findByTestId("month-grid");
    fireEvent.click(screen.getByTestId("day-2027-03-04"));
    fireEvent.click(await screen.findByTestId("move-a1"));
    fireEvent.click(await screen.findByTestId("slot-2027-03-04T11:00:00.000Z"));
    fireEvent.click(screen.getByTestId("confirm-slot"));

    const alert = await screen.findByTestId("slot-failure");
    // Losing the race is the design working, and it reads as a sentence rather than a code.
    expect(alert.textContent).not.toContain("SLOT_TAKEN");
    expect(alert.textContent?.length ?? 0).toBeGreaterThan(5);
  });
});
