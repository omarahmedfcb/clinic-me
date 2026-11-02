// The schedule editor's state, loading and saving, moved out of SchedulesPage unchanged.
// SchedulesPage renders what this returns; nothing here draws anything.

import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocale } from "../../i18n/locale-context.tsx";
import { useSession } from "../auth/session.tsx";
import { isDoctorRole, ownDoctorId } from "../auth/own-doctor.ts";
import {
  applyPattern,
  inferPattern,
  initialSettingsOpen,
  nextOccurrence,

  oneOffBlockedWindows,
  type WorkingHoursPattern,
} from "./pattern.ts";
import { addDays, today, weekStartOf } from "./schedule-dates.ts";
import type { DayMode } from "./WeeklyTemplates.tsx";
import {
  addException,
  loadDoctors,
  loadSchedule,
  loadWeek,
  saveTemplates,
  type DoctorSummary,
  type ScheduleException,
  type ScheduleTemplate,
  type WeekDay,
} from "./schedules-api.ts";

export function useScheduleEditor() {
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

  return {
    doctors, doctorId, setDoctorId, doctor, canManageClinicWide, baseline, dayMode, setDayMode,
    settingsOpen, setSettingsOpen, onceDate, setOnceDate, exceptions, pattern, setPattern,
    resetOverrides, setResetOverrides, dirty, setDirty, weekStart, setWeekStart, week, weekLoading,
    weekError, loading, loadFailed, saving, saveError, exceptionBusy, setExceptionBusy, exceptionError,
    setExceptionError, readOnly, refresh, applied, templates, preserved, onSave, editDay,
  };
}
