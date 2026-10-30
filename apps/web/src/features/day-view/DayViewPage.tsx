import { DayKpis } from "./DayKpis.tsx";
import { summariseDay } from "./day-kpis.ts";
import { Button } from "../../design-system/Button.tsx";
import { EmptyState } from "../../design-system/display.tsx";
import { Select, TextInput } from "../../design-system/fields.tsx";
import { Spinner } from "../../design-system/Spinner.tsx";
import { intlLocale } from "../../i18n/format.ts";
import { useLocale } from "../../i18n/locale-context.tsx";
import { isDoctorRole } from "../auth/own-doctor.ts";
import { AppointmentDetailPanel } from "../appointment-detail/AppointmentDetailPanel.tsx";
import { DISPLAY_TIME_ZONE } from "../../lib/clinic-time-zone.ts";
import { DayBody } from "./DayBody.tsx";
import { addDays, today } from "./day-dates.ts";
import { useDayView } from "./use-day-view.ts";

/**
 * Reception's calendar: one doctor, one day.
 *
 * ## It renders `describeDay()`, and computes nothing
 *
 * Every band on this screen comes from the server's `working`, `busy` and `free` arrays. The
 * screen decides where to draw them and nothing else. If the calendar worked availability out by
 * its own route it could disagree with the booking endpoint, and a receptionist looking at a gap
 * the booking flow refuses has no way to tell which is lying.
 *
 * ## The timeline is scaled to the session, not to the day
 *
 * A 0–24 axis would be mostly empty for a clinic working four hours, and — the case that matters —
 * would have to **split a session that crosses midnight across two dates**, which is exactly what
 * PHASE-2.md Q8 exists to prevent. The Thursday night clinic running 22:00 to 02:00 is one
 * session that began on Thursday, so it must read as one continuous band on Thursday.
 *
 * So the axis runs from the earliest working start to the latest working end, whatever calendar
 * dates those fall on. A cross-midnight session is then simply a long band, and the note under it
 * says the hours run past midnight.
 *
 * ## Fully booked is not the same as not working
 *
 * `describeDay()` returns `fullyBooked` precisely because an empty free list erases that
 * distinction, and the two mean opposite things to a receptionist: one is a doctor to stop booking
 * into, the other is a day that was never set up. They get different empty states.
 */

export function DayViewPage() {
  const { t, locale } = useLocale();
  const {
    me,
    doctors,
    doctorId,
    setDoctorId,
    date,
    setDate,
    day,
    loading,
    failed,
    openId,
    setOpenId,
    ownDoctorLabel,
    refresh,
  } = useDayView();

  // The tenant's zone. Hardcoding it here would be the one place CLAUDE.md forbids a literal, but
  // the day view renders a tenant's own clinic and the API already resolved everything in that
  // zone — these instants are absolute, so this only decides how they are *labelled*.
  const timeZone = DISPLAY_TIME_ZONE;
  const clock = new Intl.DateTimeFormat(intlLocale(locale), {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

  /** The clinic's calendar date for an instant — used to tell a cross-midnight session apart. */
  const calendarDay = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    dateStyle: "short",
  });

  if (loading && doctors === null) {
    return (
      <div className="flex justify-center py-16">
        <Spinner size="lg" />
      </div>
    );
  }

  if (doctors !== null && doctors.length === 0) {
    return (
      <EmptyState title={t("day.noDoctors")} message={t("day.noDoctors")} />
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-lg font-semibold">{t("day.title")}</h1>
        <p className="text-sm text-ink-muted">{t("day.subtitle")}</p>
      </div>

      <div className="flex flex-wrap items-end gap-3 print:hidden">
        {/* A doctor account is one doctor, so it gets a label, not a picker. See own-doctor.ts. */}
        <div className="w-72">
          {isDoctorRole(me) ? (
            <div>
              <span className="block text-sm font-medium text-ink-muted">
                {t("day.doctor")}
              </span>
              <p className="mt-1 text-sm">{ownDoctorLabel ?? "—"}</p>
            </div>
          ) : (
            <Select
              label={t("day.doctor")}
              value={doctorId ?? ""}
              onChange={(event) => setDoctorId(event.target.value)}
              options={(doctors ?? []).map((d) => ({
                value: d.id,
                label: `${d.title} ${d.fullName} — ${d.specialty}`,
              }))}
            />
          )}
        </div>

        <div className="w-44">
          <TextInput
            type="date"
            label={t("day.date")}
            value={date}
            onChange={(event) => setDate(event.target.value)}
          />
        </div>

        <div className="flex items-center gap-2 pb-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setDate((d) => addDays(d, -1))}
          >
            {t("day.prev")}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setDate(today())}>
            {t("day.today")}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setDate((d) => addDays(d, 1))}
          >
            {t("day.next")}
          </Button>
        </div>
      </div>

      {loading && (
        <div className="flex justify-center py-10">
          <Spinner />
        </div>
      )}

      {!loading && failed && (
        <EmptyState title={t("day.loadFailed")} message={t("day.loadFailed")} />
      )}

      {!loading && !failed && day !== null && (
        <>
          {/*
            The four cards, from `day.busy` — the same array `DayBody` draws the bars from, so a
            card and a bar cannot disagree. `new Date()` is passed in here rather than read inside
            `summariseDay`, which is what makes `late` testable.
          */}
          <DayKpis summary={summariseDay(day.busy, new Date())} />
          <DayBody
            day={day}
            clock={clock}
            calendarDay={calendarDay}
            onOpenAppointment={setOpenId}
          />
        </>
      )}

      <AppointmentDetailPanel
        appointmentId={openId}
        onClose={() => setOpenId(null)}
        onChanged={() => {
          if (doctorId !== null) void refresh(doctorId, date);
        }}
      />
    </div>
  );
}
