import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { LocaleProvider } from "../../i18n/locale-context.tsx";
import { MonthGrid, monthCells } from "./MonthGrid.tsx";

/**
 * The month grid — «المواعيد», Phase 5 PR 13.
 *
 * The arithmetic is tested as a function rather than through the rendered squares: a month that
 * starts on the wrong column is a bug nobody sees until the day they click the wrong date, and
 * counting `<button>`s would not say which day each one is.
 */

afterEach(cleanup);

describe("the calendar arithmetic", () => {
  test("a month is padded to whole weeks, starting on Saturday", () => {
    // 2027-03-01 is a Monday. The Egyptian week starts on Saturday, so Monday is the third column
    // and two padding cells come first.
    const cells = monthCells("2027-03");
    expect(cells.slice(0, 3)).toEqual([null, null, "2027-03-01"]);
    expect(cells.length % 7).toBe(0);
    expect(cells.filter((cell) => cell !== null)).toHaveLength(31);
  });

  test("a month that begins on a Saturday needs no padding", () => {
    // 2027-05-01 is a Saturday: the first column, so nothing precedes it.
    const cells = monthCells("2027-05");
    expect(cells[0]).toBe("2027-05-01");
  });

  test("February is 28 days, and 29 in a leap year", () => {
    expect(monthCells("2027-02").filter(Boolean)).toHaveLength(28);
    expect(monthCells("2028-02").filter(Boolean)).toHaveLength(29);
  });
});

describe("the grid", () => {
  const DAYS = [
    {
      date: "2027-03-04",
      total: 3,
      finished: 0,
      byDoctor: [
        { doctorId: "d1", doctorName: "د. هشام", count: 2 },
        { doctorId: "d2", doctorName: "د. دينا", count: 1 },
      ],
    },
    // A day in the past: nothing standing, everything done. It must still read as a day that had
    // appointments on it — three empty months was the review finding.
    { date: "2027-03-06", total: 0, finished: 27, byDoctor: [] },
  ];

  test("each day shows its count per doctor, which is what the ruling asks for", () => {
    render(
      <LocaleProvider>
        <MonthGrid month="2027-03" days={DAYS} selected={null} onSelect={() => {}} />
      </LocaleProvider>,
    );
    const day = screen.getByTestId("day-2027-03-04");
    expect(day.textContent).toContain("د. هشام");
    expect(day.textContent).toContain("2");
    expect(day.textContent).toContain("د. دينا");
    // A day with no bookings has no counts, rather than a zero for every doctor.
    expect(screen.getByTestId("day-2027-03-05").textContent).toBe("5");
  });

  test("a finished day carries its muted count, and a live day does not fake one", () => {
    render(
      <LocaleProvider>
        <MonthGrid month="2027-03" days={DAYS} selected={null} onSelect={() => {}} />
      </LocaleProvider>,
    );
    expect(screen.getByTestId("finished-2027-03-06").textContent).toBe("27");
    // The square is the date and the muted count, and nothing else: no doctor row carrying a zero,
    // and no total that has added the two together — they mean opposite things to a receptionist.
    expect(screen.getByTestId("day-2027-03-06").textContent).toBe("627");
    expect(screen.queryByTestId("finished-2027-03-04")).toBeNull();
  });

  test("clicking a day selects it", () => {
    const onSelect = vi.fn();
    render(
      <LocaleProvider>
        <MonthGrid month="2027-03" days={DAYS} selected={null} onSelect={onSelect} />
      </LocaleProvider>,
    );
    fireEvent.click(screen.getByTestId("day-2027-03-04"));
    expect(onSelect).toHaveBeenCalledWith("2027-03-04");
  });

  test("a padding cell is not a day and cannot be clicked", () => {
    render(
      <LocaleProvider>
        <MonthGrid month="2027-03" days={[]} selected={null} onSelect={() => {}} />
      </LocaleProvider>,
    );
    // 31 days, and no more buttons than that: an empty square that reacts to a click is a date
    // belonging to no month.
    expect(screen.getAllByRole("button")).toHaveLength(31);
  });
});
