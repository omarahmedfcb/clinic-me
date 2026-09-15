import { Button } from "../../design-system/Button.tsx";
import { Card } from "../../design-system/display.tsx";
import { TextInput } from "../../design-system/fields.tsx";
import { useLocale } from "../../i18n/locale-context.tsx";
import type { TranslationKey } from "../../i18n/strings.ts";
import { WEEKDAY_DISPLAY_ORDER, type ScheduleTemplate } from "./schedules-api.ts";

/**
 * Breaks — step 5 of the input flow, in their own section.
 *
 * They used to be nested inside each day's row. That is what "nothing else on that row" rules out,
 * and dropping them entirely was not an option either: a break is a real part of a working day and
 * the schema has a table for it. So they live here, below the days, which is also the order the
 * flow asks for — a break hangs off a template, so the days have to exist first.
 *
 * Only working days appear. A break on a day the doctor does not work is not a thing to enter.
 */

interface Props {
  templates: ScheduleTemplate[];
  onEditDay: (weekday: number, patch: Partial<ScheduleTemplate>) => void;
  readOnly: boolean;
}

export function BreaksSection({ templates, onEditDay, readOnly }: Props) {
  const { t } = useLocale();
  const weekdayLabel = (weekday: number): string =>
    t(`schedules.weekday.${weekday}` as TranslationKey);

  const ordered = [...templates].sort(
    (a, b) =>
      WEEKDAY_DISPLAY_ORDER.indexOf(a.weekday as never) -
      WEEKDAY_DISPLAY_ORDER.indexOf(b.weekday as never),
  );

  return (
    <Card title={t("schedules.breaks.title")}>
      {ordered.length === 0 ? (
        <p className="text-sm text-ink-muted">{t("schedules.weekly.empty")}</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {ordered.map((template) => (
            <li key={template.weekday} className="border-b border-border pb-3 last:border-b-0">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">{weekdayLabel(template.weekday)}</span>
                {!readOnly && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() =>
                      onEditDay(template.weekday, {
                        breaks: [...template.breaks, { startTime: "13:00", endTime: "13:30", label: "" }],
                      })
                    }
                  >
                    {t("schedules.breaks.add")}
                  </Button>
                )}
              </div>

              {template.breaks.map((brk, i) => (
                <div key={i} className="mt-2 flex flex-wrap items-end gap-2">
                  <div className="w-28">
                    <TextInput
                      type="time"
                      label={t("schedules.weekly.from")}
                      value={brk.startTime}
                      disabled={readOnly}
                      onChange={(event) =>
                        onEditDay(template.weekday, {
                          breaks: template.breaks.map((b, j) =>
                            j === i ? { ...b, startTime: event.target.value } : b,
                          ),
                        })
                      }
                    />
                  </div>
                  <div className="w-28">
                    <TextInput
                      type="time"
                      label={t("schedules.weekly.to")}
                      value={brk.endTime}
                      disabled={readOnly}
                      onChange={(event) =>
                        onEditDay(template.weekday, {
                          breaks: template.breaks.map((b, j) =>
                            j === i ? { ...b, endTime: event.target.value } : b,
                          ),
                        })
                      }
                    />
                  </div>
                  <div className="w-44">
                    <TextInput
                      label={t("schedules.breaks.label")}
                      placeholder={t("schedules.breaks.labelPlaceholder")}
                      value={brk.label}
                      disabled={readOnly}
                      onChange={(event) =>
                        onEditDay(template.weekday, {
                          breaks: template.breaks.map((b, j) =>
                            j === i ? { ...b, label: event.target.value } : b,
                          ),
                        })
                      }
                    />
                  </div>
                  {!readOnly && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        onEditDay(template.weekday, {
                          breaks: template.breaks.filter((_, j) => j !== i),
                        })
                      }
                    >
                      {t("schedules.weekly.remove")}
                    </Button>
                  )}
                </div>
              ))}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
