import { Button } from "../../design-system/Button.tsx";
import { EmptyState } from "../../design-system/display.tsx";
import { Select } from "../../design-system/fields.tsx";
import { Spinner } from "../../design-system/Spinner.tsx";
import { useLocale } from "../../i18n/locale-context.tsx";
import type { TranslationKey } from "../../i18n/strings.ts";
import { useSession } from "../auth/session.tsx";
import { isDoctorRole } from "../auth/own-doctor.ts";
import { downloadCsv, downloadFile } from "./download.ts";
import { scheduleToCsv } from "./export-spreadsheet.ts";
import { ExceptionList } from "./ExceptionList.tsx";
import { nextOccurrence } from "./pattern.ts";
import { PatternEditor } from "./PatternEditor.tsx";
import { BreaksSection } from "./BreaksSection.tsx";
import { weekToIcs } from "./export-calendar.ts";
import { WeeklyTemplates } from "./WeeklyTemplates.tsx";
import { WeekGrid } from "./WeekGrid.tsx";
import { DISPLAY_TIME_ZONE } from "../../lib/clinic-time-zone.ts";
import { addException, removeException } from "./schedules-api.ts";
import { addDays, today, weekStartOf } from "./schedule-dates.ts";
import { useScheduleEditor } from "./use-schedule-editor.ts";

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
export function SchedulesPage() {
  const { t } = useLocale();
  const { authFetch, me } = useSession();
  const {
    doctors, doctorId, setDoctorId, doctor, canManageClinicWide, baseline, dayMode, setDayMode,
    settingsOpen, setSettingsOpen, onceDate, setOnceDate, exceptions, pattern, setPattern,
    resetOverrides, setResetOverrides, dirty, setDirty, weekStart, setWeekStart, week, weekLoading,
    weekError, loading, loadFailed, saving, saveError, exceptionBusy, setExceptionBusy, exceptionError,
    setExceptionError, readOnly, refresh, applied, templates, preserved, onSave, editDay,
  } = useScheduleEditor();

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
        timeZone={DISPLAY_TIME_ZONE}
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
