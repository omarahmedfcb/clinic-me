import { Button } from "../../design-system/Button.tsx";
import { Card } from "../../design-system/display.tsx";
import { TextInput } from "../../design-system/fields.tsx";
import { useLocale } from "../../i18n/locale-context.tsx";
import type { TranslationKey } from "../../i18n/strings.ts";
import { isOverride, type WorkingHoursPattern } from "./pattern.ts";
import { WEEKDAY_DISPLAY_ORDER, type ScheduleTemplate } from "./schedules-api.ts";

/**
 * The working days. **One line per day, and nothing else on it.**
 *
 * A day is: the weekday, a start, an end. If those differ from the pattern, one choice appears —
 * *every [weekday]* or *once on [date]* — and nothing more. No badge, no reset button, no reason
 * field, no add button, no explanatory hint. An earlier version had all of those and was more
 * controls doing the same two jobs, which is the opposite of simplification.
 *
 * ## Why one question rather than a mode switch
 *
 * Two different records already exist for two different facts:
 *
 * - "Thursday ends at 18:00 instead of 21:00" — **different working hours**, recurring, a
 *   `schedule_templates` row.
 * - "Next Wednesday, external visit 12:00–14:00" — **one-off on a date**, a `schedule_exceptions`
 *   row of type `BLOCKED`.
 *
 * A control labelled "save as a daily pattern or for a period" would be one control doing two jobs
 * and would require the user to understand the schema to choose. *Does this repeat, or is it
 * once?* is answerable without knowing the system exists. The word "template" never appears.
 *
 * ## What this row cannot do
 *
 * A day here is a start and an end, so it can shorten a day but cannot put a hole in the middle of
 * one. The external visit from 12:00 to 14:00 belongs in the unavailable-times list below, which is
 * named for exactly that. There is deliberately no hint here saying so — the row stays one line,
 * and the section below carries the meaning in its own title.
 *
 * ## Everything commits on save
 *
 * Choosing "once" does not write anything on its own. It records the choice, and the save button
 * applies the lot: recurring rows go into the templates PUT, "once" rows become exceptions. One
 * action, so a half-applied screen is not a state the user can reach.
 */

export type DayMode = "recurring" | "once";

interface Props {
  templates: ScheduleTemplate[];
  pattern: WorkingHoursPattern | null;
  onEditDay: (weekday: number, patch: Partial<ScheduleTemplate>) => void;
  dayMode: Record<number, DayMode>;
  onDayModeChange: (weekday: number, mode: DayMode) => void;
  onceDate: Record<number, string>;
  onOnceDateChange: (weekday: number, date: string) => void;
  saving: boolean;
  dirty: boolean;
  error: string | null;
  onSave: () => void;
  readOnly: boolean;
}

export function WeeklyTemplates({
  templates,
  pattern,
  onEditDay,
  dayMode,
  onDayModeChange,
  onceDate,
  onOnceDateChange,
  saving,
  dirty,
  error,
  onSave,
  readOnly,
}: Props) {
  const { t } = useLocale();
  const weekdayLabel = (weekday: number): string =>
    t(`schedules.weekday.${weekday}` as TranslationKey);

  const ordered = [...templates].sort(
    (a, b) =>
      WEEKDAY_DISPLAY_ORDER.indexOf(a.weekday as never) -
      WEEKDAY_DISPLAY_ORDER.indexOf(b.weekday as never),
  );

  return (
    <Card
      title={t("schedules.overrides.title")}
      subtitle={t("schedules.overrides.subtitle")}
      actions={
        readOnly ? undefined : (
          <div className="flex items-center gap-2 print:hidden">
            {dirty && (
              <span className="rounded bg-warning-soft px-2 py-0.5 text-xs text-warning">
                {t("schedules.unsaved")}
              </span>
            )}
            <Button size="sm" loading={saving} onClick={onSave}>
              {t("schedules.weekly.save")}
            </Button>
          </div>
        )
      }
    >
      {error !== null && (
        <p role="alert" className="mb-4 rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
          {error}
        </p>
      )}

      {ordered.length === 0 ? (
        <p className="text-sm text-ink-muted">{t("schedules.weekly.empty")}</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {ordered.map((template) => {
            const changed = pattern !== null && isOverride(template, pattern);
            const mode = dayMode[template.weekday] ?? "recurring";

            return (
              <li key={template.weekday} className="flex flex-wrap items-end gap-3 border-b border-border pb-3 last:border-b-0">
                <div className="w-24 pb-2 text-sm font-medium">{weekdayLabel(template.weekday)}</div>

                <div className="w-28">
                  <TextInput
                    type="time"
                    label={t("schedules.weekly.from")}
                    value={template.startTime}
                    disabled={readOnly}
                    onChange={(event) => onEditDay(template.weekday, { startTime: event.target.value })}
                  />
                </div>

                <div className="w-28">
                  <TextInput
                    type="time"
                    label={t("schedules.weekly.to")}
                    value={template.endTime}
                    disabled={readOnly}
                    error={
                      template.endTime === template.startTime
                        ? t("schedules.pattern.emptyWindow")
                        : undefined
                    }
                    onChange={(event) => onEditDay(template.weekday, { endTime: event.target.value })}
                  />
                </div>

                {/*
                  The choice appears only once the day differs. Asking "does this repeat?" of a day
                  that matches the pattern would be asking about nothing, and would put a control on
                  every row to serve the few that need it.
                */}
                {changed && !readOnly && (
                  <div className="flex flex-wrap items-center gap-4 pb-2">
                    <label className="flex items-center gap-2 text-sm">
                      <input
                        type="radio"
                        name={`mode-${template.weekday}`}
                        checked={mode === "recurring"}
                        onChange={() => onDayModeChange(template.weekday, "recurring")}
                      />
                      {t("schedules.day.recurring").replace("{weekday}", weekdayLabel(template.weekday))}
                    </label>

                    <label className="flex items-center gap-2 text-sm">
                      <input
                        type="radio"
                        name={`mode-${template.weekday}`}
                        checked={mode === "once"}
                        onChange={() => onDayModeChange(template.weekday, "once")}
                      />
                      {t("schedules.day.onceOn")}
                    </label>

                    {mode === "once" && (
                      <input
                        type="date"
                        aria-label={t("schedules.exceptions.date")}
                        value={onceDate[template.weekday] ?? ""}
                        onChange={(event) => onOnceDateChange(template.weekday, event.target.value)}
                        className="rounded-lg border border-border bg-surface px-2 py-1 text-sm"
                      />
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
