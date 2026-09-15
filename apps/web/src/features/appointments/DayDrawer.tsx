// The day a month cell opens: an hour spine with each booking in its slot — Phase 5 PR 13, amended.
// Hours and free time come from `describeDay()`, so this panel and the booking flow cannot disagree.

import { useEffect, useState } from "react";
import { Button } from "../../design-system/Button.tsx";
import { StatusBadge } from "../../design-system/display.tsx";
import { Drawer } from "../../design-system/overlays.tsx";
import { canReschedule, type AppointmentStatus } from "../../domain/appointment-status.ts";
import { intlLocale } from "../../i18n/format.ts";
import { useLocale } from "../../i18n/locale-context.tsx";
import { loadDay as loadDayTimeline, type DayDescription } from "../day-view/day-view-api.ts";
import type { DayBooking } from "./book-api.ts";

type AuthFetch = (path: string, init?: RequestInit) => Promise<Response>;

interface Span {
  fromMs: number;
  toMs: number;
}

/** An hour of the clinic's own day: what is booked in it, and which doctors have room left. */
export interface HourRow {
  hour: number;
  bookings: DayBooking[];
  freeDoctorIds: string[];
}

const HOUR_MS = 3_600_000;

const spans = (windows: { start: string; end: string }[]): Span[] =>
  windows.map((window) => ({ fromMs: Date.parse(window.start), toMs: Date.parse(window.end) }));

const overlaps = (span: Span, fromMs: number, toMs: number): boolean =>
  span.fromMs < toMs && span.toMs > fromMs;

/**
 * The hour rows of one day, from the doctors' working windows outwards.
 *
 * Pure and exported so `DayDrawer.spec.tsx` can check the spine without a fetch: the arithmetic is
 * where a timeline goes wrong, and it needs no browser to be checked.
 */
export function hourRows(
  midnightMs: number,
  days: { doctorId: string; day: DayDescription }[],
  bookings: DayBooking[],
): HourRow[] {
  const hourOf = (ms: number): number => Math.floor((ms - midnightMs) / HOUR_MS);

  const hours: number[] = [];
  for (const { day } of days) {
    for (const window of spans(day.working)) {
      // The end is exclusive: a session ending at 17:00 does not occupy the 17:00 row.
      for (let hour = hourOf(window.fromMs); hour <= hourOf(window.toMs - 1); hour += 1) hours.push(hour);
    }
  }
  for (const booking of bookings) hours.push(hourOf(Date.parse(booking.startsAt)));
  if (hours.length === 0) return [];

  const first = Math.min(...hours);
  const last = Math.max(...hours);

  const rows: HourRow[] = [];
  for (let hour = first; hour <= last; hour += 1) {
    const fromMs = midnightMs + hour * HOUR_MS;
    const toMs = fromMs + HOUR_MS;
    rows.push({
      hour,
      bookings: bookings.filter((booking) => {
        const at = Date.parse(booking.startsAt);
        return at >= fromMs && at < toMs;
      }),
      freeDoctorIds: days
        .filter(({ day }) => spans(day.free).some((span) => overlaps(span, fromMs, toMs)))
        .map(({ doctorId }) => doctorId),
    });
  }
  return rows;
}

/**
 * Clinic-local midnight for a date, from the offset the server reported.
 *
 * Never a timezone literal and never the browser's zone: `describeDay()` resolved the day in the
 * tenant's zone and returns the offset it used, so the spine is labelled with the clinic's hours.
 * The browser's own offset is the last resort, for a day on which no doctor works at all.
 */
export function midnightFor(date: string, days: { day: DayDescription }[], bookings: DayBooking[]): number {
  const utcMidnight = Date.parse(`${date}T00:00:00Z`);
  const reported = days.flatMap(({ day }) => day.working).at(0)?.utcOffsetMinutes;
  if (reported !== undefined) return utcMidnight - reported * 60_000;

  const sample = bookings.at(0)?.startsAt;
  if (sample === undefined) return utcMidnight;
  return utcMidnight + new Date(Date.parse(sample)).getTimezoneOffset() * 60_000;
}

export function DayDrawer({
  authFetch,
  date,
  bookings,
  doctors,
  doctorId,
  readOnly,
  now,
  onClose,
  onNew,
  onMove,
}: {
  authFetch: AuthFetch;
  date: string;
  bookings: DayBooking[];
  doctors: { id: string; name: string }[];
  /** The filter in force: one doctor, or `""` for the whole clinic. */
  doctorId: string;
  readOnly: boolean;
  /** The reference instant, passed in rather than read: it decides whether this day is behind us. */
  now: Date;
  onClose: () => void;
  /** Book: from a free hour, with the doctor who has room and the instant it starts, or plain. */
  onNew: (prefer?: { doctorId: string; fromIso: string }) => void;
  onMove: (booking: DayBooking) => void;
}) {
  const { t, locale } = useLocale();
  // Null until the spine is known. Drawing the bookings first and the working hours a moment later
  // rebuilds every row under the reader's cursor, which loses the click they were making.
  const [days, setDays] = useState<{ doctorId: string; day: DayDescription }[] | null>(null);

  const inScope = doctorId === "" ? doctors : doctors.filter((doctor) => doctor.id === doctorId);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const loaded = await Promise.all(
        inScope.map(async (doctor) => {
          try {
            return { doctorId: doctor.id, day: await loadDayTimeline(authFetch, doctor.id, date) };
          } catch {
            // A doctor whose day cannot be read is left out of the spine rather than failing the
            // panel: the bookings are already in hand and are what the reader came for.
            return null;
          }
        }),
      );
      if (!cancelled) setDays(loaded.filter((entry) => entry !== null));
    })();
    return () => {
      cancelled = true;
    };
  }, [authFetch, date, doctorId, doctors.length]);

  const midnightMs = midnightFor(date, days ?? [], bookings);
  /**
   * **A day that is wholly behind us offers nothing to book or move.**
   *
   * Whole days, in the clinic's own time: midnight of the *next* day has to have passed, so today
   * keeps its controls until it ends. The API refuses a past slot exactly (`PAST_SLOT`) — this is
   * the coarser screen rule the founder asked for, not a restatement of it.
   */
  const past = midnightMs + 24 * HOUR_MS <= now.getTime();
  /** Booking and moving are offered when the day is still ahead and the reader may act at all. */
  const mayAct = !readOnly && !past;
  const rows = days === null ? [] : hourRows(midnightMs, days, bookings);
  const nameOf = new Map(doctors.map((doctor) => [doctor.id, doctor.name]));

  // `intlLocale` carries `-u-nu-latn`, so the explicit option is gone with it: one place decides the
  // numbering system for the whole app (ruled 2026-09-12, landed on develop with #100).
  const clock = new Intl.DateTimeFormat(intlLocale(locale), {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "UTC",
  });
  /** Time since clinic midnight, laid back onto the UTC day and formatted there: the clinic's clock. */
  const clinicTime = (ms: number): string =>
    clock.format(new Date(Date.parse(`${date}T00:00:00Z`) + (ms - midnightMs)));

  return (
    <Drawer
      open
      title={date}
      onOpenChange={(open) => (open ? undefined : onClose())}
      footer={
        mayAct ? (
          <Button size="sm" data-testid="new-booking" onClick={() => onNew()}>
            {t("book.newBooking")}
          </Button>
        ) : undefined
      }
    >
      {readOnly && (
        <p className="mb-3 text-xs text-ink-muted" data-testid="book-read-only">
          {t("book.readOnly")}
        </p>
      )}

      {/* Said, not left to be inferred from absent buttons: a reader who came to move something
          should learn why they cannot rather than hunt for the control. */}
      {past && !readOnly && (
        <p className="mb-3 text-xs text-ink-muted" data-testid="book-past-day">
          {t("book.pastDay")}
        </p>
      )}

      {days === null ? (
        <p className="text-sm text-ink-muted" data-testid="day-loading">
          {t("common.loading")}
        </p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-ink-muted" data-testid="day-empty">
          {t("book.noBookings")}
        </p>
      ) : (
        <ol className="grid gap-1" data-testid="day-timeline">
          {rows.map((row) => {
            const fromMs = midnightMs + row.hour * HOUR_MS;
            const bookable = mayAct && row.freeDoctorIds.length > 0;
            return (
              <li key={row.hour} className="flex items-stretch gap-2" data-testid={`hour-${row.hour}`}>
                <span className="numeric w-12 shrink-0 pt-2 text-xs text-ink-muted">
                  {clinicTime(fromMs)}
                </span>

                <div className="flex-1 border-s border-border ps-2">
                  {row.bookings.length === 0 ? (
                    bookable ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        fullWidth
                        data-testid={`book-hour-${row.hour}`}
                        onClick={() =>
                          onNew({
                            doctorId: row.freeDoctorIds[0] ?? "",
                            fromIso: new Date(fromMs).toISOString(),
                          })
                        }
                      >
                        {t("book.bookHere")}
                      </Button>
                    ) : (
                      <span className="block min-h-8 rounded-md bg-surface-sunken/40" aria-hidden="true" />
                    )
                  ) : (
                    <ul className="grid gap-1">
                      {row.bookings.map((booking) => (
                        <li
                          key={booking.appointmentId}
                          className="flex flex-wrap items-baseline justify-between gap-2 rounded-lg bg-surface-sunken px-2 py-1.5"
                          data-testid={`booking-${booking.appointmentId}`}
                        >
                          <span className="text-sm text-ink">
                            <span className="numeric me-2 text-xs text-ink-muted">
                              {clinicTime(Date.parse(booking.startsAt))}
                            </span>
                            {booking.patientName}
                            <span className="ms-2 text-xs text-ink-subtle">
                              {nameOf.get(booking.doctorId) ?? booking.doctorName}
                            </span>
                          </span>
                          <span className="flex items-baseline gap-2">
                            <StatusBadge status={booking.status as AppointmentStatus} />
                            {/* No drag (the ruling): a move is a dialog. And the screen asks the
                                state machine whether a move is legal rather than deciding itself. */}
                            {mayAct && canReschedule(booking.status as AppointmentStatus) && (
                              <Button
                                size="sm"
                                variant="ghost"
                                data-testid={`move-${booking.appointmentId}`}
                                onClick={() => onMove(booking)}
                              >
                                {t("book.move")}
                              </Button>
                            )}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </Drawer>
  );
}
