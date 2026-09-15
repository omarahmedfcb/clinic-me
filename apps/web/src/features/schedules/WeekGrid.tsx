import { Button } from "../../design-system/Button.tsx";
import { Card } from "../../design-system/display.tsx";
import { Spinner } from "../../design-system/Spinner.tsx";
import { intlLocale } from "../../i18n/format.ts";
import { useLocale } from "../../i18n/locale-context.tsx";
import type { TranslationKey } from "../../i18n/strings.ts";
import type { WeekDay } from "./schedules-api.ts";

/**
 * Seven boxes, one per day, each showing that day's appointments.
 *
 * ## One request, not seven
 *
 * The data comes from `GET /schedule/range`, which runs `describeDay()` per date over a single
 * fetch. Two reasons, and the second is the one that matters:
 *
 * - **Cost.** Measured: seven sequential `/schedule/day` calls take 639 ms against 130 ms for one
 *   range call. Each of the seven re-verifies a JWT, opens a transaction, and re-reads the same
 *   templates, breaks and exceptions the previous six already read.
 * - **Consistency.** Seven requests are seven snapshots. An appointment booked between the third
 *   and the fourth leaves the week disagreeing with itself on screen — a bug that shows up only on
 *   a busy morning and cannot be reproduced afterwards.
 *
 * It is the **same computation** as the booking flow, not a second one:
 * `schedule-range.integration.spec.ts` asserts each day equals what the single-day endpoint
 * returns, field by field, and fails if anyone reimplements the loop.
 */

interface Props {
  days: WeekDay[];
  loading: boolean;
  error: string | null;
  weekStart: string;
  onShiftWeek: (days: number) => void;
  onToday: () => void;
  timeZone: string;
}

export function WeekGrid({ days, loading, error, weekStart, onShiftWeek, onToday, timeZone }: Props) {
  const { t, locale } = useLocale();

  const hhmm = new Intl.DateTimeFormat(intlLocale(locale), {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

  return (
    <Card
      title={t("schedules.week.title")}
      subtitle={weekStart}
      actions={
        <div className="flex items-center gap-2 print:hidden">
          <Button variant="ghost" size="sm" onClick={() => onShiftWeek(-7)}>
            {t("schedules.week.prev")}
          </Button>
          <Button variant="ghost" size="sm" onClick={onToday}>
            {t("schedules.week.today")}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => onShiftWeek(7)}>
            {t("schedules.week.next")}
          </Button>
        </div>
      }
    >
      {error !== null && (
        <p role="alert" className="mb-4 rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
          {error}
        </p>
      )}

      {loading ? (
        <div className="flex justify-center py-10">
          <Spinner />
        </div>
      ) : (
        // Seven columns on a wide screen, two on a phone. `overflow-x-auto` is not used: a
        // calendar that scrolls sideways hides days, and the week is the whole point.
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
          {days.map((day) => {
            const weekday = new Date(`${day.date}T12:00:00Z`).getUTCDay();
            const closed = day.working.length === 0;

            return (
              <div
                key={day.date}
                className={
                  closed
                    ? "rounded-lg border border-border bg-surface-sunken p-2"
                    : "rounded-lg border border-border bg-surface p-2"
                }
              >
                <div className="mb-2 border-b border-border pb-1">
                  <p className="text-xs font-medium">
                    {t(`schedules.weekday.${weekday}` as TranslationKey)}
                  </p>
                  <p className="text-[11px] text-ink-muted">{day.date.slice(5)}</p>
                </div>

                {closed ? (
                  <p className="text-[11px] text-ink-subtle">{t("schedules.week.dayOff")}</p>
                ) : (
                  <>
                    {day.busy.length === 0 ? (
                      <p className="text-[11px] text-ink-muted">
                        {t("schedules.week.appointments").replace("{n}", "0")}
                      </p>
                    ) : (
                      <ul className="flex flex-col gap-1">
                        {day.busy.map((block) => (
                          <li
                            key={block.appointmentId}
                            className="rounded bg-primary-soft px-1.5 py-1 text-[11px] text-primary"
                          >
                            {hhmm.format(new Date(block.start))}
                          </li>
                        ))}
                      </ul>
                    )}

                    <p className="mt-2 text-[11px] text-ink-muted">
                      {day.fullyBooked
                        ? t("schedules.week.fullyBooked")
                        : t("schedules.week.free").replace("{n}", String(day.free.length))}
                    </p>
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}
