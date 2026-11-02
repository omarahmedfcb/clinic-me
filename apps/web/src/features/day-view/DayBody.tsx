import { Card, EmptyState, StatusBadge } from "../../design-system/display.tsx";
import { useLocale } from "../../i18n/locale-context.tsx";
import type { DayDescription } from "./day-view-api.ts";
import { DayTimeline } from "./DayTimeline.tsx";

export function DayBody({
  day,
  clock,
  calendarDay,
  onOpenAppointment,
}: {
  day: DayDescription;
  clock: Intl.DateTimeFormat;
  calendarDay: Intl.DateTimeFormat;
  /** Opens the detail panel. Owned by the page, because the panel outlives this body. */
  onOpenAppointment: (appointmentId: string) => void;
}) {
  const { t } = useLocale();

  /*
    The two empty states, and the reason they are two.

    A doctor who does not work today and a doctor booked solid both have no free time. Collapsing
    them into "no availability" would tell a receptionist to stop booking when the real answer is
    that nobody has set the day up yet.
  */
  if (day.working.length === 0) {
    return (
      <EmptyState
        title={t("day.notWorking.title")}
        message={t("day.notWorking.body")}
      />
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {day.fullyBooked && (
        <div className="rounded-lg border border-warning bg-warning-soft px-3 py-2">
          <p className="text-sm font-medium text-warning">
            {t("day.fullyBooked.title")}
          </p>
          <p className="text-xs text-warning">{t("day.fullyBooked.body")}</p>
        </div>
      )}

      <DayTimeline
        day={day}
        clock={clock}
        calendarDay={calendarDay}
        onOpenAppointment={onOpenAppointment}
      />

      {day.busy.length > 0 && (
        <Card title={t("day.list.title")}>
          <ul className="flex flex-col gap-2">
            {day.busy.map((block) => (
              <li
                key={block.appointmentId}
                className="flex items-center gap-3 rounded-lg border border-border px-3 py-2 text-sm"
              >
                <span className="font-medium">
                  {clock.format(new Date(block.start))}
                </span>
                <span className="text-ink-muted">
                  – {clock.format(new Date(block.end))}
                </span>
                {/*
                  The same ruling as the timeline, in its badge form. The bar above answers "how
                  full is the day"; this answers "where is each patient in the visit", which is a
                  question about one row and needs the word as well as the colour.
                */}
                <span className="ms-auto">
                  <StatusBadge status={block.status} />
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
