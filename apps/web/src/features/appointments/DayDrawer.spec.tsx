import { describe, expect, test } from "vitest";
import { hourRows, midnightFor } from "./DayDrawer.tsx";
import type { DayDescription } from "../day-view/day-view-api.ts";
import type { DayBooking } from "./book-api.ts";

/**
 * The drawer's arithmetic, without a browser: the spine is where a timeline goes wrong.
 *
 * The hours are the **clinic's**, taken from the offset `describeDay()` reports. Bucketing in the
 * browser's zone would file a 22:00 Cairo appointment under the next day for a reader in London,
 * which is the same defect the month counts already guard against in SQL.
 */

const booking = (startsAt: string, id = "a1"): DayBooking => ({
  appointmentId: id,
  patientName: "مريم",
  doctorId: "d1",
  doctorName: "د. هشام",
  serviceId: "s1",
  serviceName: "كشف",
  startsAt,
  status: "BOOKED",
});

const day = (working: [string, string][], free: [string, string][], utcOffsetMinutes: number): DayDescription => ({
  date: "2027-03-04",
  doctorId: "d1",
  working: working.map(([start, end]) => ({ start, end, utcOffsetMinutes })),
  busy: [],
  free: free.map(([start, end]) => ({ start, end })),
  unavailable: [],
  fullyBooked: false,
});

describe("the day drawer's spine", () => {
  test("midnight comes from the clinic's offset, not the browser's", () => {
    // Cairo is +02 in March. Clinic midnight is 22:00 UTC the evening before.
    const cairo = midnightFor("2027-03-04", [{ day: day([["2027-03-04T08:00:00Z", "2027-03-04T12:00:00Z"]], [], 120) }], []);
    expect(new Date(cairo).toISOString()).toBe("2027-03-03T22:00:00.000Z");
  });

  test("with no working window there is no offset to read, and the day is taken as UTC", () => {
    // The offset only travels on `working`, so a day nobody works carries none. Flagged, not hidden:
    // the rows are then labelled in UTC, which is wrong by the clinic's offset.
    const none = midnightFor("2027-03-04", [{ day: day([], [], 120) }], []);
    expect(new Date(none).toISOString()).toBe("2027-03-04T00:00:00.000Z");
  });

  test("the spine spans the working day, not only the booked hours", () => {
    const rows = hourRows(
      Date.parse("2027-03-04T00:00:00Z"),
      [{ doctorId: "d1", day: day([["2027-03-04T08:00:00Z", "2027-03-04T12:00:00Z"]], [], 0) }],
      [booking("2027-03-04T09:00:00Z")],
    );
    expect(rows.map((row) => row.hour)).toEqual([8, 9, 10, 11]);
  });

  test("a session ending on the hour does not occupy that hour's row", () => {
    const rows = hourRows(
      Date.parse("2027-03-04T00:00:00Z"),
      [{ doctorId: "d1", day: day([["2027-03-04T08:00:00Z", "2027-03-04T10:00:00Z"]], [], 0) }],
      [],
    );
    expect(rows.map((row) => row.hour)).toEqual([8, 9]);
  });

  test("a booking outside the working day still gets a row", () => {
    // It exists, so it is shown. A timeline that hides it is how a booking goes unnoticed.
    const rows = hourRows(
      Date.parse("2027-03-04T00:00:00Z"),
      [{ doctorId: "d1", day: day([["2027-03-04T08:00:00Z", "2027-03-04T10:00:00Z"]], [], 0) }],
      [booking("2027-03-04T14:00:00Z")],
    );
    expect(rows.map((row) => row.hour)).toEqual([8, 9, 10, 11, 12, 13, 14]);
    expect(rows.at(-1)?.bookings).toHaveLength(1);
  });

  test("each booking lands in its own hour", () => {
    const rows = hourRows(
      Date.parse("2027-03-04T00:00:00Z"),
      [{ doctorId: "d1", day: day([["2027-03-04T08:00:00Z", "2027-03-04T11:00:00Z"]], [], 0) }],
      [booking("2027-03-04T08:15:00Z", "a1"), booking("2027-03-04T08:45:00Z", "a2"), booking("2027-03-04T10:00:00Z", "a3")],
    );
    expect(rows.find((row) => row.hour === 8)?.bookings.map((b) => b.appointmentId)).toEqual(["a1", "a2"]);
    expect(rows.find((row) => row.hour === 9)?.bookings).toHaveLength(0);
    expect(rows.find((row) => row.hour === 10)?.bookings.map((b) => b.appointmentId)).toEqual(["a3"]);
  });

  test("an hour is offered for booking only where a doctor actually has room", () => {
    const rows = hourRows(
      Date.parse("2027-03-04T00:00:00Z"),
      [
        {
          doctorId: "d1",
          day: day([["2027-03-04T08:00:00Z", "2027-03-04T11:00:00Z"]], [["2027-03-04T10:00:00Z", "2027-03-04T11:00:00Z"]], 0),
        },
      ],
      [],
    );
    expect(rows.find((row) => row.hour === 8)?.freeDoctorIds).toEqual([]);
    expect(rows.find((row) => row.hour === 10)?.freeDoctorIds).toEqual(["d1"]);
  });

  test("a day nobody works and nothing is booked on has no rows", () => {
    expect(hourRows(Date.parse("2027-03-04T00:00:00Z"), [], [])).toEqual([]);
  });
});
