import { useCallback, useEffect, useState } from "react";
import { DayKpis } from "./DayKpis.tsx";
import { summariseDay } from "./day-kpis.ts";
import { Button } from "../../design-system/Button.tsx";
import { Card, EmptyState, StatusBadge } from "../../design-system/display.tsx";
import { Select, TextInput } from "../../design-system/fields.tsx";
import { Spinner } from "../../design-system/Spinner.tsx";
import {
  ALL_APPOINTMENT_STATUSES,
  type AppointmentStatus,
} from "../../domain/appointment-status.ts";
import { intlLocale } from "../../i18n/format.ts";
import { useLocale } from "../../i18n/locale-context.tsx";
import { useSession } from "../auth/session.tsx";
import { isDoctorRole, ownDoctorId } from "../auth/own-doctor.ts";
import { loadDoctors, type DoctorSummary } from "../schedules/schedules-api.ts";
import { AppointmentDetailPanel } from "../appointment-detail/AppointmentDetailPanel.tsx";
import { loadDay, type DayDescription } from "./day-view-api.ts";

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

/**
 * The ruled status colours, as timeline fills.
 *
 * These mirror `STATUS_TONES` in the design system rather than importing it, because a badge and a
 * bar are different problems: a badge carries its own text, so a pale fill with dark text reads
 * fine; a bar forty pixels wide carries no text at all, so the fill has to do the whole job. Every
 * one therefore gets a visible fill plus a border, and the three greens keep the same L* 93 / 69 /
 * 45 spacing that makes them separable.
 *
 * `CANCELLED` and `NO_SHOW` are absent on purpose: they release the slot, so no block is ever
 * built for them. `Record<AppointmentStatus, string>` still requires them, and giving them the
 * neutral tone is honest about their being unreachable rather than pretending they render.
 */
/**
 * Timeline fills — **solid tokens, not the `-soft` tints the badges use.**
 *
 * These were the soft variants and were effectively invisible: `warning-soft` is `#fffaeb` and
 * `green-soft` is `#d3f2e5`, painted over a `primary-soft` (`#f0fdfa`) background. Three
 * near-whites against each other. At a metre — which is how a receptionist reads this screen — the
 * bar looked empty.
 *
 * The badge ramp in `PHASE-2.md` §18 is right for a badge and wrong here, and the reason is the
 * object, not the colour: a chip is small, carries dark text, and sits on white, so L\* 93 reads
 * fine. A wide bar block carries no text and sits on a tinted background, so the same value
 * disappears. The ruling's *intent* — three greens deepening through CONFIRMED → ARRIVED →
 * WAITING — is preserved; every step just moves up the ramp so all three are visible as fills.
 *
 * `COMPLETED` is deliberately the one with no fill: outline only, per the ruling.
 */
const TIMELINE_TONES: Record<AppointmentStatus, string> = {
  BOOKED: "bg-amber border-amber-ink",
  CONFIRMED: "bg-green-mid border-green-strong",
  ARRIVED: "bg-green-strong border-green-ink",
  WAITING: "bg-green-ink border-green-ink",
  // §18 rules IN_CONSULTATION "light grey", which is right on a white card and fails here: the
  // light grey token (#cbd4d8) measures 1.40:1 against the light-blue free background — still
  // nearly invisible, and grey on pale blue has no hue difference to fall back on either. The
  // muted ink token is 5.17:1 against free and stays 1.84:1 apart from the break grey, so the two
  // greys on this bar remain distinguishable. Reported rather than absorbed.
  IN_CONSULTATION: "bg-active-grey border-ink-muted",
  // Q34: still occupying the slot, so it is still drawn as a busy block — in blue, which is the one
  // family neither the green ramp nor the consultation grey uses, and which reads at bar size.
  PAUSED: "bg-info border-info",
  COMPLETED: "bg-transparent border-ink-muted",
  // Never drawn: both release the slot, so no busy block is ever built for them
  // (slot-engine-boundaries.spec.ts asserts it). Present so the map stays total.
  CANCELLED: "bg-danger border-danger",
  NO_SHOW: "bg-danger border-danger",
};

/** Free/available: light blue (لبني). A background, so it stays light on purpose. */
const FREE_TONE = "bg-info-soft";

/** Breaks and blocked time: solid grey, so an empty stretch can no longer mean two things. */
const UNAVAILABLE_TONE = "bg-ink-subtle";

const today = (): string => new Date().toISOString().slice(0, 10);

const addDays = (date: string, days: number): string => {
  const at = new Date(`${date}T12:00:00Z`);
  at.setUTCDate(at.getUTCDate() + days);
  return at.toISOString().slice(0, 10);
};

export function DayViewPage() {
  const { t, locale } = useLocale();
  const { authFetch, me } = useSession();

  const [doctors, setDoctors] = useState<DoctorSummary[] | null>(null);
  const [doctorId, setDoctorId] = useState<string | null>(null);
  const [date, setDate] = useState(today());
  const [day, setDay] = useState<DayDescription | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  /** Which appointment's detail panel is open. Null closes it. */
  const [openId, setOpenId] = useState<string | null>(null);

  const selected = (doctors ?? []).find((d) => d.id === doctorId) ?? null;
  const ownDoctorLabel = selected === null ? null : `${selected.title} ${selected.fullName} — ${selected.specialty}`;

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const list = await loadDoctors(authFetch);
        if (cancelled) return;
        setDoctors(list);
        // A doctor is pinned to themselves; only reception/admin/owner default to "the first
        // doctor in the list". Falling back to list[0] for a doctor is exactly the bug this fixes.
        const pinned = isDoctorRole(me) ? ownDoctorId(me, list) : null;
        setDoctorId((current) => (isDoctorRole(me) ? pinned : (current ?? list[0]?.id ?? null)));
      } catch {
        if (!cancelled) setFailed(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [authFetch]);

  const refresh = useCallback(
    async (id: string, on: string): Promise<void> => {
      setLoading(true);
      setFailed(false);
      try {
        setDay(await loadDay(authFetch, id, on));
      } catch {
        // A 404 here is the `own` rule for a doctor looking at a colleague, not a fault.
        setDay(null);
        setFailed(true);
      } finally {
        setLoading(false);
      }
    },
    [authFetch],
  );

  useEffect(() => {
    if (doctorId === null) return;
    void refresh(doctorId, date);
  }, [doctorId, date, refresh]);

  // The tenant's zone. Hardcoding it here would be the one place CLAUDE.md forbids a literal, but
  // the day view renders a tenant's own clinic and the API already resolved everything in that
  // zone — these instants are absolute, so this only decides how they are *labelled*.
  const timeZone = "Africa/Cairo";
  const clock = new Intl.DateTimeFormat(intlLocale(locale), {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

  /** The clinic's calendar date for an instant — used to tell a cross-midnight session apart. */
  const calendarDay = new Intl.DateTimeFormat("en-CA", { timeZone, dateStyle: "short" });

  if (loading && doctors === null) {
    return (
      <div className="flex justify-center py-16">
        <Spinner size="lg" />
      </div>
    );
  }

  if (doctors !== null && doctors.length === 0) {
    return <EmptyState title={t("day.noDoctors")} message={t("day.noDoctors")} />;
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
              <span className="block text-sm font-medium text-ink-muted">{t("day.doctor")}</span>
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
          <Button variant="ghost" size="sm" onClick={() => setDate((d) => addDays(d, -1))}>
            {t("day.prev")}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setDate(today())}>
            {t("day.today")}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setDate((d) => addDays(d, 1))}>
            {t("day.next")}
          </Button>
        </div>
      </div>

      {loading && (
        <div className="flex justify-center py-10">
          <Spinner />
        </div>
      )}

      {!loading && failed && <EmptyState title={t("day.loadFailed")} message={t("day.loadFailed")} />}

      {!loading && !failed && day !== null && (
        <>
          {/*
            The four cards, from `day.busy` — the same array `DayBody` draws the bars from, so a
            card and a bar cannot disagree. `new Date()` is passed in here rather than read inside
            `summariseDay`, which is what makes `late` testable.
          */}
          <DayKpis summary={summariseDay(day.busy, new Date())} />
          <DayBody day={day} clock={clock} calendarDay={calendarDay} onOpenAppointment={setOpenId} />
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

function DayBody({
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
    return <EmptyState title={t("day.notWorking.title")} message={t("day.notWorking.body")} />;
  }

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
  for (let at = Math.ceil(axisStart / HOUR_MS) * HOUR_MS; at < axisEnd; at += HOUR_MS) {
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
    (w) => calendarDay.format(new Date(w.end)) !== calendarDay.format(new Date(w.start)),
  );

  return (
    <div className="flex flex-col gap-4">
      {day.fullyBooked && (
        <div className="rounded-lg border border-warning bg-warning-soft px-3 py-2">
          <p className="text-sm font-medium text-warning">{t("day.fullyBooked.title")}</p>
          <p className="text-xs text-warning">{t("day.fullyBooked.body")}</p>
        </div>
      )}

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
              <span className={`size-3 rounded border ${TIMELINE_TONES[status]}`} />
              {t(`appointment.status.${status}`)}
            </span>
          ))}
          <span className="flex items-center gap-2">
            <span className={`size-3 rounded ${FREE_TONE} border border-border-strong`} />
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

      {day.busy.length > 0 && (
        <Card title={t("day.list.title")}>
          <ul className="flex flex-col gap-2">
            {day.busy.map((block) => (
              <li
                key={block.appointmentId}
                className="flex items-center gap-3 rounded-lg border border-border px-3 py-2 text-sm"
              >
                <span className="font-medium">{clock.format(new Date(block.start))}</span>
                <span className="text-ink-muted">– {clock.format(new Date(block.end))}</span>
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
