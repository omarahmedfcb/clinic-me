// The month grid itself — Phase 5 PR 13. Pure: it takes days and renders squares.
// Split out so the calendar arithmetic can be tested without a screen, a session or a fetch.

import { useLocale } from "../../i18n/locale-context.tsx";
import type { MonthDay } from "./book-api.ts";

/**
 * The calendar days of `YYYY-MM`, padded to whole weeks.
 *
 * **The week starts on Saturday**, which is the Egyptian week — Sunday to Thursday is the working
 * run, and a grid starting on Monday puts the weekend either side of it. `null` is a padding cell,
 * not a day: an empty string would render as a clickable square belonging to no date.
 *
 * Pure and exported: `MonthGrid.spec.tsx` checks the shape of February and of a month that starts
 * on the first column, neither of which needs a browser.
 */
export function monthCells(month: string): (string | null)[] {
  const [year, index] = month.split("-").map(Number) as [number, number];
  const first = new Date(Date.UTC(year, index - 1, 1));
  const daysInMonth = new Date(Date.UTC(year, index, 0)).getUTCDate();
  // getUTCDay: 0 = Sunday. Saturday (6) is the first column, so Sunday lands in column 1.
  const lead = (first.getUTCDay() + 1) % 7;

  const cells: (string | null)[] = Array.from({ length: lead }, () => null);
  for (let day = 1; day <= daysInMonth; day += 1) {
    cells.push(`${month}-${String(day).padStart(2, "0")}`);
  }
  while (cells.length % 7 !== 0) cells.push(null);
  return cells;
}

export function MonthGrid({
  month,
  days,
  selected,
  onSelect,
}: {
  month: string;
  days: MonthDay[];
  selected: string | null;
  onSelect: (date: string) => void;
}) {
  const { t } = useLocale();
  const byDate = new Map(days.map((day) => [day.date, day]));
  const weekdays = ["SAT", "SUN", "MON", "TUE", "WED", "THU", "FRI"] as const;

  return (
    <div data-testid="month-grid">
      <div className="grid grid-cols-7 gap-1 text-center text-xs text-ink-muted">
        {weekdays.map((weekday) => (
          <div key={weekday} className="py-1">
            {t(`book.weekday.${weekday}` as never)}
          </div>
        ))}
      </div>

      <div className="grid grid-cols-7 gap-1">
        {monthCells(month).map((date, index) =>
          date === null ? (
            // A padding cell is not a day: it has no date, so it is not a button.
            <div key={`pad-${index}`} aria-hidden="true" className="min-h-20 rounded-lg bg-transparent" />
          ) : (
            <button
              key={date}
              type="button"
              data-testid={`day-${date}`}
              aria-pressed={selected === date}
              onClick={() => onSelect(date)}
              className={`min-h-20 rounded-lg border p-1 text-start align-top ${
                selected === date
                  ? "border-primary bg-surface-sunken"
                  : "border-border bg-surface hover:bg-surface-sunken"
              }`}
            >
              <span className="flex items-baseline justify-between gap-1">
                <span className="numeric text-xs font-medium text-ink">{Number(date.slice(8))}</span>
                {/* The finished half, muted and smaller: history is readable without competing with
                    what is still standing. Never added to the live count — they mean opposite things. */}
                {(byDate.get(date)?.finished ?? 0) > 0 && (
                  <span
                    className="numeric text-[10px] text-ink-subtle"
                    title={t("book.finished")}
                    data-testid={`finished-${date}`}
                  >
                    {byDate.get(date)?.finished}
                  </span>
                )}
              </span>
              <span className="mt-1 flex flex-col gap-0.5">
                {(byDate.get(date)?.byDoctor ?? []).map((row) => (
                  <span key={row.doctorId} className="flex items-baseline justify-between gap-1 text-[10px]">
                    <span className="truncate text-ink-subtle">{row.doctorName}</span>
                    <span className="numeric text-ink">{row.count}</span>
                  </span>
                ))}
              </span>
            </button>
          ),
        )}
      </div>
    </div>
  );
}
