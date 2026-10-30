import { Card } from "../../design-system/display.tsx";
import { ALL_APPOINTMENT_STATUSES } from "../../domain/appointment-status.ts";
import { useLocale } from "../../i18n/locale-context.tsx";
import type { DayDescription } from "./day-view-api.ts";
import { FREE_TONE, TIMELINE_TONES, UNAVAILABLE_TONE } from "./timeline-tones.ts";

export function DayTimeline({
  day,
  clock,
  calendarDay,
  onOpenAppointment,
}: {
  day: DayDescription;
  clock: Intl.DateTimeFormat;
  calendarDay: Intl.DateTimeFormat;
  onOpenAppointment: (appointmentId: string) => void;
}) {
  const { t } = useLocale();

  const ms = (iso: string): number => Date.parse(iso);
  const axisStart = Math.min(...day.working.map((w) => ms(w.start)));
  const axisEnd = Math.max(...day.working.map((w) => ms(w.end)));
  const span = Math.max(axisEnd - axisStart, 1);
  const pct = (value: number): number => ((value - axisStart) / span) * 100;

  /**
   * Every whole hour inside the axis.
   *
   * Stepped from the first hour boundary at or after `axisStart` rather than from `axisStart`
   * itself, so the lines land on 10:00 and 11:00 rather than on 09:17 and 10:17 — a scale whose
   * ticks are not on the hour is harder to read than no scale.
   *
   * Derived from instants, so a session spanning a DST change still gets one line per real hour.
   */
  const HOUR_MS = 3_600_000;
  const hourTicks: number[] = [];
  for (
    let at = Math.ceil(axisStart / HOUR_MS) * HOUR_MS;
    at < axisEnd;
    at += HOUR_MS
  ) {
    hourTicks.push(at);
  }

  /**
   * The current instant, but only when it actually falls inside the day on screen.
   *
   * `null` for any other date — a marker pinned to an edge on yesterday's view would be read as
   * "now", and a line that is sometimes meaningless is worse than no line.
   */
  const nowMs = Date.now();
  const nowAt = nowMs >= axisStart && nowMs <= axisEnd ? nowMs : null;

  /**
   * A session whose end falls on a later calendar date than its start ran past midnight —
   * compared in the CLINIC'S timezone, not in UTC.
   *
   * This was UTC first and was wrong in exactly the case it exists for: a Cairo clinic running
   * 22:00 to 02:00 is 19:00Z to 23:00Z, which is the same UTC day. The badge never appeared on the
   * one session it was written to describe.
   */
  const crossesMidnight = day.working.some(
    (w) =>
      calendarDay.format(new Date(w.end)) !==
      calendarDay.format(new Date(w.start)),
  );

  return (
      <Card
        title={t("day.session")}
        subtitle={`${clock.format(new Date(axisStart))} – ${clock.format(new Date(axisEnd))}`}
        actions={
          crossesMidnight ? (
            <span className="rounded bg-primary-soft px-2 py-1 text-xs text-primary">
              ↪ {t("day.crossesMidnight")}
            </span>
          ) : undefined
        }
      >
        {/*
          One track per working session. A cross-midnight session is a single track here because the
          axis is the session's own span rather than a calendar day — which is the whole point of
          Q8: the Thursday night clinic is one session that began on Thursday.
        */}
        {/*
          ONE continuous bar, not one track per working session.

          A break sits *between* two working windows, so with a track per window there was nowhere
          to draw it — the break was the space between two tracks, which is exactly the ambiguity
          being fixed. Spanning the whole session lets every minute be painted and accounted for:
          `free`, `busy` and `unavailable` together cover the open hours, so no stretch is left to
          be interpreted.
        */}
        <div className="mb-1 flex justify-between text-xs text-ink-muted">
          <span className="numeric">{clock.format(new Date(axisStart))}</span>
          <span className="numeric">{clock.format(new Date(axisEnd))}</span>
        </div>

        <div className="relative h-12 w-full overflow-hidden rounded-lg border border-border bg-surface-sunken">
          {/* Free/available underneath, so a booked block always paints over it. */}
          {day.free.map((free) => (
            <div
              key={`free-${free.start}`}
              title={`${t("day.free")} ${clock.format(new Date(free.start))}`}
              className={`absolute inset-y-0 ${FREE_TONE}`}
              style={{
                // `insetInlineStart`, not `left`: the axis runs right-to-left in Arabic, and a
                // physical side would put every appointment on the wrong end of the day in one
                // of the two languages. web-logical-properties.spec.ts fails the build on it.
                insetInlineStart: `${pct(ms(free.start))}%`,
                width: `${((ms(free.end) - ms(free.start)) / span) * 100}%`,
              }}
            />
          ))}

          {/* Breaks and blocked time. Solid, because "empty" must not mean two things. */}
          {day.unavailable.map((gap) => (
            <div
              key={`gap-${gap.start}`}
              title={`${t("day.unavailable")} ${clock.format(new Date(gap.start))} – ${clock.format(new Date(gap.end))}`}
              className={`absolute inset-y-0 ${UNAVAILABLE_TONE}`}
              style={{
                insetInlineStart: `${pct(ms(gap.start))}%`,
                width: `${Math.max(((ms(gap.end) - ms(gap.start)) / span) * 100, 0.5)}%`,
              }}
            />
          ))}

          {/* Hour gridlines, so a block can be read against a clock rather than against the ends. */}
          {hourTicks.map((tick) => (
            <div
              key={`tick-${tick}`}
              aria-hidden="true"
              className="absolute inset-y-0 w-px bg-ink-subtle/30"
              style={{ insetInlineStart: `${pct(tick)}%` }}
            />
          ))}

          {/* A block is a button: clicking an appointment opens its detail panel. */}
          {day.busy.map((block) => (
            <button
              type="button"
              key={block.appointmentId}
              onClick={() => onOpenAppointment(block.appointmentId)}
              title={`${clock.format(new Date(block.start))} — ${t(`appointment.status.${block.status}`)}`}
              className={`absolute inset-y-1 rounded border ${TIMELINE_TONES[block.status]}`}
              style={{
                insetInlineStart: `${pct(ms(block.start))}%`,
                width: `${Math.max(((ms(block.end) - ms(block.start)) / span) * 100, 1)}%`,
              }}
            />
          ))}

          {/*
            "Where are we now" — the first question asked of a screen that stays open all day.
            Only drawn when the date being viewed actually contains the current instant, so
            yesterday and tomorrow do not get a marker at a meaningless position.
          */}
          {nowAt !== null && (
            <div
              className="absolute inset-y-0 w-0.5 bg-danger"
              title={t("day.now")}
              style={{ insetInlineStart: `${pct(nowAt)}%` }}
            />
          )}
        </div>

        {/* Hour labels, under the bar and aligned to the same gridlines. */}
        <div className="relative mt-1 h-4">
          {hourTicks.map((tick) => (
            <span
              key={`label-${tick}`}
              className="numeric absolute -translate-x-1/2 text-[11px] text-ink-subtle"
              style={{ insetInlineStart: `${pct(tick)}%` }}
            >
              {clock.format(new Date(tick))}
            </span>
          ))}
        </div>

        {/*
          The legend lists every colour the bar can draw today — statuses present, plus free and
          unavailable. A key that omits one of them turns the colour it omits into a puzzle, which
          is what the grey band would otherwise be.
        */}
        <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-border pt-3 text-xs">
          {ALL_APPOINTMENT_STATUSES.filter((status) =>
            day.busy.some((block) => block.status === status),
          ).map((status) => (
            <span key={status} className="flex items-center gap-2">
              <span
                className={`size-3 rounded border ${TIMELINE_TONES[status]}`}
              />
              {t(`appointment.status.${status}`)}
            </span>
          ))}
          <span className="flex items-center gap-2">
            <span
              className={`size-3 rounded ${FREE_TONE} border border-border-strong`}
            />
            {t("day.summary.free").replace("{n}", String(day.free.length))}
          </span>
          {day.unavailable.length > 0 && (
            <span className="flex items-center gap-2">
              <span className={`size-3 rounded ${UNAVAILABLE_TONE}`} />
              {t("day.unavailable")}
            </span>
          )}
          {nowAt !== null && (
            <span className="flex items-center gap-2">
              <span className="h-3 w-0.5 bg-danger" />
              {t("day.now")}
            </span>
          )}
        </div>
      </Card>
  );
}
