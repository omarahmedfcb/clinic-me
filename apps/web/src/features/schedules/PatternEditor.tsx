import { Button } from "../../design-system/Button.tsx";
import { Card } from "../../design-system/display.tsx";
import { TextInput } from "../../design-system/fields.tsx";
import { useLocale } from "../../i18n/locale-context.tsx";
import type { TranslationKey } from "../../i18n/strings.ts";
import { ALL_WEEKDAYS, type WorkingHoursPattern } from "./pattern.ts";
import { WEEKDAY_DISPLAY_ORDER } from "./schedules-api.ts";

/**
 * Steps 1–3 of the input model: hours, validity period, weekly days off.
 *
 * ## It is a weekly pattern with a validity period. It is not a monthly schedule.
 *
 * The label says "ساعات العمل" with dates, deliberately. Calling this monthly would leave the
 * first person who asks "so what happens in month two?" with no answer, because the question does
 * not apply — the pattern repeats every week until `validTo`, or forever if that is empty.
 *
 * ## The schema is unchanged
 *
 * One row per weekday is still correct: Wednesday genuinely can differ. This screen fills those
 * rows from one entry, and the per-day override section below it edits a single row. Without that
 * second half the screen would be all-or-nothing and people would go back to typing every day.
 */

interface Props {
  pattern: WorkingHoursPattern;
  onChange: (pattern: WorkingHoursPattern) => void;
  /** Weekdays that would keep their own hours if the pattern were applied now. */
  preserved: number[];
  resetOverrides: boolean;
  onResetOverridesChange: (reset: boolean) => void;
  workingDayCount: number;
  disabled: boolean;
  saving: boolean;
  dirty: boolean;
  onSave: () => void;
}

export function PatternEditor({
  pattern,
  onChange,
  preserved,
  resetOverrides,
  onResetOverridesChange,
  workingDayCount,
  disabled,
  saving,
  dirty,
  onSave,
}: Props) {
  const { t } = useLocale();
  const weekdayLabel = (weekday: number): string => t(`schedules.weekday.${weekday}` as TranslationKey);

  const toggleDayOff = (weekday: number): void => {
    const off = new Set(pattern.daysOff);
    if (off.has(weekday)) off.delete(weekday);
    else off.add(weekday);
    onChange({ ...pattern, daysOff: ALL_WEEKDAYS.filter((day) => off.has(day)) });
  };

  const emptyWindow = pattern.startTime === pattern.endTime;

  return (
    <Card
      title={t("schedules.pattern.title")}
      subtitle={t("schedules.pattern.subtitle")}
      actions={
        /*
          The save that commits these hours, next to the fields that set them. It used to live only
          on the card below, which is why changing the hours or the day off felt like it went
          nowhere -- the button that made it real was somewhere else on the page.
        */
        <div className="flex items-center gap-2 print:hidden">
          {dirty && (
            <span className="rounded bg-warning-soft px-2 py-0.5 text-xs text-warning">
              {t("schedules.unsaved")}
            </span>
          )}
          <Button size="sm" loading={saving} disabled={disabled || emptyWindow} onClick={onSave}>
            {t("schedules.pattern.save")}
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-5">
        <section>
          <h3 className="mb-2 text-sm font-medium">{t("schedules.pattern.hours")}</h3>
          <div className="flex flex-wrap items-end gap-3">
            <div className="w-32">
              <TextInput
                type="time"
                label={t("schedules.weekly.from")}
                value={pattern.startTime}
                disabled={disabled}
                onChange={(event) => onChange({ ...pattern, startTime: event.target.value })}
              />
            </div>
            <div className="w-32">
              <TextInput
                type="time"
                label={t("schedules.weekly.to")}
                value={pattern.endTime}
                disabled={disabled}
                error={emptyWindow ? t("schedules.pattern.emptyWindow") : undefined}
                onChange={(event) => onChange({ ...pattern, endTime: event.target.value })}
              />
            </div>
            {/* An end before a start is a session crossing midnight (Q8), not an error. */}
            {pattern.endTime < pattern.startTime && (
              <p className="pb-2 text-xs text-ink-muted">↪ {t("schedules.weekly.crossesMidnight")}</p>
            )}
          </div>
        </section>

        <section>
          <h3 className="mb-2 text-sm font-medium">{t("schedules.pattern.validity")}</h3>
          <div className="flex flex-wrap items-end gap-3">
            <div className="w-44">
              <TextInput
                type="date"
                label={t("schedules.weekly.validFrom")}
                value={pattern.validFrom}
                disabled={disabled}
                onChange={(event) => onChange({ ...pattern, validFrom: event.target.value })}
              />
            </div>
            <div className="w-44">
              <TextInput
                type="date"
                label={t("schedules.weekly.validTo")}
                value={pattern.validTo ?? ""}
                disabled={disabled}
                hint={pattern.validTo === null ? t("schedules.weekly.validToOpen") : undefined}
                onChange={(event) =>
                  onChange({ ...pattern, validTo: event.target.value === "" ? null : event.target.value })
                }
              />
            </div>
          </div>
        </section>

        <section>
          <h3 className="mb-1 text-sm font-medium">{t("schedules.pattern.daysOff")}</h3>
          <p className="mb-2 text-xs text-ink-muted">{t("schedules.pattern.daysOffHint")}</p>
          <div className="flex flex-wrap gap-2">
            {WEEKDAY_DISPLAY_ORDER.map((weekday) => {
              const isOff = pattern.daysOff.includes(weekday);
              return (
                <button
                  key={weekday}
                  type="button"
                  disabled={disabled}
                  aria-pressed={isOff}
                  onClick={() => toggleDayOff(weekday)}
                  className={
                    isOff
                      ? "rounded-lg border border-border bg-surface-sunken px-3 py-1.5 text-sm text-ink-muted line-through"
                      : "rounded-lg border border-primary bg-primary-soft px-3 py-1.5 text-sm text-primary"
                  }
                >
                  {weekdayLabel(weekday)}
                </button>
              );
            })}
          </div>
        </section>

        {/*
          The summary. The pattern applies to the day cards **live** — toggling a day off removes
          its card immediately, because a control that changes nothing visible reads as broken.
          Nothing is persisted until the save button below.

          Overrides survive a pattern change (see pattern.ts on why the two failure modes are not
          symmetric), and preserving them silently would be its own trap — so the days keeping
          their own hours are named here, and resetting them is an explicit choice.
        */}
        <section className="rounded-lg border border-border bg-surface-sunken p-3">
          <p className="text-sm">
            {t("schedules.pattern.applies").replace("{days}", String(workingDayCount))}
          </p>

          {preserved.length > 0 && (
            <div className="mt-2">
              <p className="text-sm text-ink-muted">
                {t("schedules.pattern.keepsOverrides")}{" "}
                <span className="font-medium text-ink">
                  {preserved.map(weekdayLabel).join("، ")}
                </span>
              </p>
              <label className="mt-2 flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={resetOverrides}
                  disabled={disabled}
                  onChange={(event) => onResetOverridesChange(event.target.checked)}
                />
                {t("schedules.pattern.resetOverrides")}
              </label>
            </div>
          )}

        </section>
      </div>
    </Card>
  );
}
