import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "../../design-system/Button.tsx";
import { EmptyState } from "../../design-system/display.tsx";
import { Select } from "../../design-system/fields.tsx";
import { Spinner } from "../../design-system/Spinner.tsx";
import { useLocale } from "../../i18n/locale-context.tsx";
import type { TranslationKey } from "../../i18n/strings.ts";
import { useSession } from "../auth/session.tsx";
import { isDoctorRole, ownDoctorId } from "../auth/own-doctor.ts";
import { downloadCsv, downloadFile } from "./download.ts";
import { scheduleToCsv } from "./export-spreadsheet.ts";
import { ExceptionList } from "./ExceptionList.tsx";
import {
  applyPattern,
  inferPattern,
  initialSettingsOpen,
  nextOccurrence,

  oneOffBlockedWindows,
  type WorkingHoursPattern,
} from "./pattern.ts";
import { PatternEditor } from "./PatternEditor.tsx";
import { BreaksSection } from "./BreaksSection.tsx";
import { weekToIcs } from "./export-calendar.ts";
import { WeeklyTemplates, type DayMode } from "./WeeklyTemplates.tsx";
import { WeekGrid } from "./WeekGrid.tsx";
import {
  addException,
  loadDoctors,
  loadSchedule,
  loadWeek,
  removeException,
  saveTemplates,
  type DoctorSummary,
  type ScheduleException,
  type ScheduleTemplate,
  type WeekDay,
} from "./schedules-api.ts";

/**
 * Checkpoint 4, screen one — the schedule editor, in the order a human actually thinks.
 *
 * 1. Working hours — one start, one end, applied to every working day
 * 2. Validity period — from, to (empty means ongoing)
 * 3. Weekly day off — Friday, or Friday and Saturday
 * 4. Per-day override — optional, and the reason the screen is not all-or-nothing
 * 5. Breaks — added after the days exist, because a break hangs off a template
 * 6. Exceptions — one-off dates
 *
 * Steps 1–3 generate the set in one PUT; step 4 edits one row. The schema is unchanged: one row
 * per weekday is still correct, because Wednesday genuinely can differ.
 */
const today = (): string => new Date().toISOString().slice(0, 10);

/** Saturday of the week containing `date` — the Egyptian week starts there. */
function weekStartOf(date: string): string {
  const at = new Date(`${date}T12:00:00Z`);
  const shift = (at.getUTCDay() + 1) % 7; // Saturday = 6 -> 0
  at.setUTCDate(at.getUTCDate() - shift);
  return at.toISOString().slice(0, 10);
}

const addDays = (date: string, days: number): string => {
  const at = new Date(`${date}T12:00:00Z`);
  at.setUTCDate(at.getUTCDate() + days);
  return at.toISOString().slice(0, 10);
};

export function SchedulesPage() {
  const { t } = useLocale();
  const { authFetch, me } = useSession();

  const [doctors, setDoctors] = useState<DoctorSummary[] | null>(null);
  const [doctorId, setDoctorId] = useState<string | null>(null);
  /**
   * The server's rows. Never edited directly — the working set is derived from this, the pattern
   * and the manual per-day edits, so applying a pattern is idempotent. Editing a single
   * `templates` array in place made the second application read its own output as the "previous"
   * pattern and lose every override.
   */
  const [baseline, setBaseline] = useState<ScheduleTemplate[]>([]);
  /** Per-day hour and break edits made in this session, keyed by weekday. */
  const [manual, setManual] = useState<Record<number, Partial<ScheduleTemplate>>>({});
  /** Per changed day: does it repeat, or happen once? Recorded here, applied on save. */
  const [dayMode, setDayMode] = useState<Record<number, DayMode>>({});
  /**
   * Whether the working-hours settings are showing.
   *
   * `null` until the schedule has loaded, because the answer depends on what came back: a doctor
   * with no saved schedule gets them **open**. That is the one moment the screen has to explain
   * itself — a first-time doctor must not have to find a button to discover where hours are set.
   * Once a schedule exists, the settings are a thing you occasionally revisit, and the day-to-day
   * work is the week and the unavailable times, so they collapse.
   */
  const [settingsOpen, setSettingsOpen] = useState<boolean | null>(null);
  const [onceDate, setOnceDate] = useState<Record<number, string>>({});
  const [exceptions, setExceptions] = useState<ScheduleException[]>([]);
  const [pattern, setPattern] = useState<WorkingHoursPattern | null>(null);
  const [resetOverrides, setResetOverrides] = useState(false);
  const [dirty, setDirty] = useState(false);

  const [weekStart, setWeekStart] = useState(() => weekStartOf(today()));
  const [week, setWeek] = useState<WeekDay[]>([]);
  const [weekLoading, setWeekLoading] = useState(false);
  const [weekError, setWeekError] = useState<string | null>(null);

  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [exceptionBusy, setExceptionBusy] = useState(false);
  const [exceptionError, setExceptionError] = useState<string | null>(null);
  const [readOnly, setReadOnly] = useState(false);

  const canManageClinicWide = me.permissions["doctorSchedules.manage"] === "full";
  const doctor = doctors?.find((d) => d.id === doctorId) ?? null;

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const list = await loadDoctors(authFetch);
        if (cancelled) return;
        setDoctors(list);
        // Pinned for a doctor, first-in-list for reception/admin/owner. See own-doctor.ts.
        const pinned = isDoctorRole(me) ? ownDoctorId(me, list) : null;
        setDoctorId((current) => (isDoctorRole(me) ? pinned : (current ?? list[0]?.id ?? null)));
      } catch {
        if (!cancelled) setLoadFailed(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [authFetch]);

  const refresh = useCallback(
    async (id: string): Promise<void> => {
      setSaveError(null);
      setExceptionError(null);
      setDirty(false);
      setResetOverrides(false);
      try {
        const schedule = await loadSchedule(authFetch, id);
        setBaseline(schedule.templates);
        // Only decided on the first load for a doctor: reopening it on every refresh would slam
        // the panel shut under someone who had deliberately opened it and just pressed save.
        setSettingsOpen((current) => initialSettingsOpen(current, schedule.templates.length));
        setManual({});
        setDayMode({});
        setOnceDate({});
        setExceptions(schedule.exceptions);
        setPattern(inferPattern(schedule.templates, today()));
        setReadOnly(false);
      } catch {
        // A 404 is the `own` rule, not a fault: this doctor may not see that schedule, and the
        // server will not say whether it exists. Empty and read-only is the truthful render.
        setBaseline([]);
        setSettingsOpen(false);
        setManual({});
        setExceptions([]);
        setPattern(null);
        setReadOnly(true);
      }
    },
    [authFetch],
  );

  /**
   * Switching doctor clears the derived state **synchronously**, before the fetch starts.
   *
   * Without this there is a window between choosing a doctor and their schedule arriving in which
   * the screen shows the NEW doctor's name above the PREVIOUS doctor's hours — and a save in that
   * window writes one doctor's working week onto another's record. That is not hypothetical: it
   * happened during verification, and `audit_logs` caught it — a doctor seeded at 10:00-14:00 came
   * back rewritten to 09:00-14:00 with a sixth working day, by a DOCTOR-role save rather than by
   * the seed.
   *
   * Clearing here means the editor renders nothing until real data arrives (`pattern === null`
   * hides it) and `onSave` cannot run, because it returns early on a null pattern.
   */
  useEffect(() => {
    if (doctorId === null) return;
    setBaseline([]);
    setPattern(null);
    setManual({});
    setDayMode({});
    setOnceDate({});
    setSettingsOpen(null);
    setSaveError(null);
    void refresh(doctorId);
  }, [doctorId, refresh]);

  useEffect(() => {
    if (doctorId === null) return;
    let cancelled = false;
    setWeekLoading(true);
    setWeekError(null);
    void (async () => {
      try {
        const days = await loadWeek(authFetch, doctorId, weekStart, addDays(weekStart, 6));
        if (!cancelled) setWeek(days);
      } catch {
        if (!cancelled) {
          setWeek([]);
          setWeekError(t("schedules.week.loadFailed"));
        }
      } finally {
        if (!cancelled) setWeekLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [authFetch, doctorId, weekStart, baseline, t]);

  /**
   * The working set, derived live.
   *
   * Toggling a day off removes its card the moment it is clicked, before any save — instant
   * feedback is what makes the screen legible, and a control that changes nothing visible reads as
   * broken. Nothing here is persisted until the save button.
   *
   * Always derived from `baseline`, never from the previous derivation, so applying twice gives
   * the same answer as applying once.
   */
  const applied = useMemo(
    () => (pattern === null ? null : applyPattern(baseline, pattern, resetOverrides)),
    [baseline, pattern, resetOverrides],
  );

  const templates = useMemo<ScheduleTemplate[]>(() => {
    if (applied === null) return [];
    return applied.templates.map((t) =>
      manual[t.weekday] === undefined ? t : { ...t, ...manual[t.weekday] },
    );
  }, [applied, manual]);

  /** Days keeping hours of their own: from the stored rows, plus anything edited in this session. */
  const preserved = useMemo(() => {
    const days = new Set(applied?.preserved ?? []);
    for (const key of Object.keys(manual)) days.add(Number(key));
    return [...days].sort((a, b) => a - b);
  }, [applied, manual]);


  /**
   * One save, reachable from either card.
   *
   * Recurring days go into the templates PUT. Days marked "once" are written as exceptions and
   * left on the pattern in the PUT, because a one-off is a fact about a date and not about every
   * week. Doing both in one action means a half-applied screen is not a state the user can reach.
   *
   * Afterwards `refresh()` replaces `baseline`, which the week-grid effect depends on — so the
   * cards at the top always reflect what was just saved. See PHASE-2.md §15 for why they do not
   * move before that.
   */
  async function onSave(): Promise<void> {
    if (doctorId === null || pattern === null) return;
    setSaving(true);
    setSaveError(null);

    const onceDays = Object.entries(dayMode)
      .filter(([, mode]) => mode === "once")
      .map(([weekday]) => Number(weekday));

    for (const weekday of onceDays) {
      const day = templates.find((template) => template.weekday === weekday);
      if (day === undefined) continue;
      const date = onceDate[weekday] ?? nextOccurrence(weekday, today());

      for (const window of oneOffBlockedWindows(pattern, day)) {
        const written = await addException(authFetch, doctorId, {
          clinicWide: false,
          date,
          type: "BLOCKED",
          startTime: window.startTime,
          endTime: window.endTime,
          reason: null,
        });
        if (!written.ok) {
          setSaveError(written.message);
          setSaving(false);
          return;
        }
      }
    }

    // "Once" days revert to the pattern in the stored week: the change was about one date.
    const toStore = templates.map((template) =>
      dayMode[template.weekday] === "once"
        ? { ...template, startTime: pattern.startTime, endTime: pattern.endTime }
        : template,
    );

    const result = await saveTemplates(authFetch, doctorId, toStore);
    if (!result.ok) setSaveError(result.message);
    else await refresh(doctorId);
    setSaving(false);
  }

  const editDay = (weekday: number, patch: Partial<ScheduleTemplate>): void => {
    setManual((current) => ({ ...current, [weekday]: { ...current[weekday], ...patch } }));
    setDirty(true);
  };

  function onExportCalendar(): void {
    if (doctor === null) return;
    const ics = weekToIcs({
      days: week,
      doctorName: `${doctor.title} ${doctor.fullName}`,
      clinicName: me.memberships.find((m) => m.membershipId === me.membershipId)?.tenantName ?? "",
      busyLabel: t("schedules.week.appointments").replace("{n} ", ""),
      generatedAt: new Date(),
    });
    downloadFile(`${t("schedules.export.filename")}-${weekStart}.ics`, ics, "text/calendar;charset=utf-8");
  }

  function onExport(): void {
    if (pattern === null || doctor === null) return;
    const weekdayNames = [0, 1, 2, 3, 4, 5, 6].map((d) =>
      t(`schedules.weekday.${d}` as TranslationKey),
    );
    const csv = scheduleToCsv({
      doctorName: `${doctor.title} ${doctor.fullName}`,
      clinicName: me.memberships.find((m) => m.membershipId === me.membershipId)?.tenantName ?? "",
      pattern,
      templates,
      exceptions,
      weekdayNames,
      generatedAt: new Date(),
      labels: {
        doctor: t("schedules.doctor.label"),
        clinic: t("shell.switchClinic"),
        pattern: t("schedules.pattern.title"),
        validity: t("schedules.pattern.validity"),
        from: t("schedules.weekly.from"),
        to: t("schedules.weekly.to"),
        daysOff: t("schedules.pattern.daysOff"),
        weekly: t("schedules.weekly.title"),
        day: t("schedules.weekly.day"),
        breaks: t("schedules.breaks.title"),
        breakLabel: t("schedules.breaks.label"),
        exceptions: t("schedules.exceptions.title"),
        date: t("schedules.exceptions.date"),
        type: t("schedules.exceptions.type"),
        scope: t("schedules.exceptions.scope"),
        clinicWide: t("schedules.exceptions.clinicWide"),
        reason: t("schedules.exceptions.reason"),
        wholeDay: t("schedules.exceptions.wholeDay"),
        generatedAt: t("schedules.export.filename"),
      },
    });
    downloadCsv(`${t("schedules.export.filename")}-${doctor.fullName}-${today()}.csv`, csv);
  }

  if (loading) {
    return (
      <div className="flex justify-center py-16">
        <Spinner size="lg" />
      </div>
    );
  }

  if (loadFailed) return <EmptyState title={t("schedules.loadFailed")} message={t("schedules.loadFailed")} />;
  if (doctors === null || doctors.length === 0) {
    return <EmptyState title={t("schedules.noDoctors.title")} message={t("schedules.noDoctors.body")} />;
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start gap-4">
        <div>
          <h1 className="text-lg font-semibold">{t("schedules.title")}</h1>
          <p className="text-sm text-ink-muted">{t("schedules.subtitle")}</p>
        </div>

        {/* Export actions. `print:hidden` so they do not appear on the sheet they produce. */}
        <div className="ms-auto flex items-center gap-2 print:hidden">
          <Button variant="secondary" size="sm" onClick={() => window.print()}>
            {t("schedules.export.print")}
          </Button>
          <Button variant="secondary" size="sm" disabled={readOnly} onClick={onExport}>
            {t("schedules.export.spreadsheet")}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            disabled={week.length === 0}
            onClick={onExportCalendar}
          >
            {t("schedules.export.calendarFile")}
          </Button>
        </div>
      </div>

      {/* A doctor account is one doctor, so it gets a label, not a picker. See own-doctor.ts. */}
      <div className="w-72 print:hidden">
        {isDoctorRole(me) ? (
          <div>
            <span className="block text-sm font-medium text-ink-muted">{t("schedules.doctor.label")}</span>
            <p className="mt-1 text-sm">
              {doctor === null ? "—" : `${doctor.title} ${doctor.fullName} — ${doctor.specialty}`}
            </p>
          </div>
        ) : (
          <Select
            label={t("schedules.doctor.label")}
            value={doctorId ?? ""}
            onChange={(event) => setDoctorId(event.target.value)}
            options={doctors.map((d) => ({ value: d.id, label: `${d.title} ${d.fullName} — ${d.specialty}` }))}
          />
        )}
      </div>

      {/* Printed sheets need to say whose schedule they are; on screen the header already does. */}
      <p className="hidden text-sm font-medium print:block">
        {doctor === null ? "" : `${doctor.title} ${doctor.fullName} — ${doctor.specialty}`}
      </p>

      <WeekGrid
        days={week}
        loading={weekLoading}
        error={weekError}
        weekStart={weekStart}
        onShiftWeek={(days) => setWeekStart((current) => addDays(current, days))}
        onToday={() => setWeekStart(weekStartOf(today()))}
        timeZone="Africa/Cairo"
      />

      {/*
        The settings toggle. It sits at the INLINE START of its row -- the right in Arabic, the
        left in English -- which `justify-start` gives without naming a physical side.
        `web-logical-properties.spec.ts` fails the build on a physical `left`/`right`, and this is
        the case that rule exists for: a hardcoded side is accidentally correct in one language.
      */}
      <div className="flex justify-start print:hidden">
        <Button
          variant="secondary"
          size="sm"
          aria-expanded={settingsOpen === true}
          onClick={() => setSettingsOpen((current) => current !== true)}
        >
          {t("schedules.settings.open")}
        </Button>
      </div>

      {settingsOpen === true && baseline.length === 0 && !readOnly && (
        <p className="rounded-lg bg-primary-soft px-3 py-2 text-sm text-primary print:hidden">
          {t("schedules.settings.firstTime")}
        </p>
      )}

      {settingsOpen === true && !readOnly && pattern !== null && applied !== null && (
        <PatternEditor
          pattern={pattern}
          onChange={(next) => {
            setPattern(next);
            setDirty(true);
          }}
          preserved={preserved}
          resetOverrides={resetOverrides}
          onResetOverridesChange={(reset) => {
            setResetOverrides(reset);
            setDirty(true);
          }}
          workingDayCount={applied.workingDays.length}
          disabled={saving}
          saving={saving}
          dirty={dirty}
          onSave={() => void onSave()}
        />
      )}

      {settingsOpen === true && (
      <WeeklyTemplates
        templates={templates}
        pattern={pattern}
        onEditDay={editDay}
        dayMode={dayMode}
        onDayModeChange={(weekday, mode) => {
          setDayMode((current) => ({ ...current, [weekday]: mode }));
          if (mode === "once" && onceDate[weekday] === undefined) {
            setOnceDate((current) => ({ ...current, [weekday]: nextOccurrence(weekday, today()) }));
          }
          setDirty(true);
        }}
        onceDate={onceDate}
        onOnceDateChange={(weekday, date) => {
          setOnceDate((current) => ({ ...current, [weekday]: date }));
          setDirty(true);
        }}
        saving={saving}
        dirty={dirty}
        error={saveError}
        onSave={() => void onSave()}
        readOnly={readOnly}
      />

      )}

      {settingsOpen === true && (
        <BreaksSection templates={templates} onEditDay={editDay} readOnly={readOnly} />
      )}

      {!readOnly && (
        <ExceptionList
          exceptions={exceptions}
          canManageClinicWide={canManageClinicWide}
          busy={exceptionBusy}
          error={exceptionError}
          onAdd={async (input) => {
            if (doctorId === null) return;
            setExceptionBusy(true);
            setExceptionError(null);
            const result = await addException(authFetch, doctorId, input);
            if (!result.ok) setExceptionError(result.message);
            else await refresh(doctorId);
            setExceptionBusy(false);
          }}
          onRemove={async (exceptionId) => {
            if (doctorId === null) return;
            setExceptionBusy(true);
            setExceptionError(null);
            const ok = await removeException(authFetch, doctorId, exceptionId);
            if (!ok) setExceptionError(t("schedules.exceptions.removeFailed"));
            else await refresh(doctorId);
            setExceptionBusy(false);
          }}
        />
      )}
    </div>
  );
}
