import { useState } from "react";
import { Button } from "../../design-system/Button.tsx";
import { Card } from "../../design-system/display.tsx";
import { Select, TextInput } from "../../design-system/fields.tsx";
import { useLocale } from "../../i18n/locale-context.tsx";
import type { TranslationKey } from "../../i18n/strings.ts";
import { EXCEPTION_TYPES, type ExceptionType, type ScheduleException } from "./schedules-api.ts";

/**
 * One-off changes to a date: a closure, a holiday, or extra hours.
 *
 * ## The clinic-wide option is hidden, not disabled, for a doctor
 *
 * A DOCTOR holds `own` on `doctorSchedules.manage`, and the API answers **404** when they try to
 * create a clinic-wide exception — closing the clinic is an admin act. So the scope control only
 * appears when the user can actually use it. Rendering it disabled would invite the question "why
 * can't I?"; rendering it not at all matches what the server will accept.
 *
 * This is a display decision and nothing else. `permissions` from `/auth/me` is a hint (see
 * `permissions.ts`), the server is what enforces it, and a user who forges the request still gets
 * a 404.
 *
 * ## Whole day versus a window
 *
 * `BLOCKED` and `HOLIDAY` may be whole-day (both times null) or partial. `EXTRA_AVAILABILITY`
 * always needs a window — a null one is not "all day available", it is meaningless, and the
 * database refuses it. The form follows that rather than letting the user discover it from a 400.
 */

interface Props {
  exceptions: ScheduleException[];
  canManageClinicWide: boolean;
  onAdd: (input: {
    clinicWide: boolean;
    date: string;
    type: ExceptionType;
    startTime: string | null;
    endTime: string | null;
    reason: string | null;
  }) => Promise<void>;
  onRemove: (exceptionId: string) => Promise<void>;
  error: string | null;
  busy: boolean;
}

export function ExceptionList({ exceptions, canManageClinicWide, onAdd, onRemove, error, busy }: Props) {
  const { t } = useLocale();

  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [type, setType] = useState<ExceptionType>("BLOCKED");
  const [clinicWide, setClinicWide] = useState(false);
  const [wholeDay, setWholeDay] = useState(true);
  const [startTime, setStartTime] = useState("09:00");
  const [endTime, setEndTime] = useState("13:00");
  const [reason, setReason] = useState("");

  // EXTRA_AVAILABILITY cannot be whole-day: there is no working day for it to add to.
  const wholeDayAllowed = type !== "EXTRA_AVAILABILITY";
  const useWholeDay = wholeDayAllowed && wholeDay;

  const typeLabel = (value: ExceptionType): string =>
    t(`schedules.exceptions.type.${value}` as TranslationKey);

  async function submit(): Promise<void> {
    await onAdd({
      clinicWide,
      date,
      type,
      startTime: useWholeDay ? null : startTime,
      endTime: useWholeDay ? null : endTime,
      reason: reason.trim() === "" ? null : reason.trim(),
    });
    setReason("");
  }

  return (
    <Card title={t("schedules.exceptions.title")} subtitle={t("schedules.exceptions.subtitle")}>
      {error !== null && (
        <p role="alert" className="mb-4 rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
          {error}
        </p>
      )}

      {exceptions.length === 0 ? (
        <p className="text-sm text-ink-muted">{t("schedules.exceptions.empty")}</p>
      ) : (
        <ul className="mb-5 flex flex-col gap-2">
          {exceptions.map((exception) => (
            <li
              key={exception.id}
              className="flex flex-wrap items-center gap-3 rounded-lg border border-border px-3 py-2 text-sm"
            >
              <span className="font-medium">{exception.date}</span>
              <span className="rounded bg-surface-sunken px-2 py-0.5 text-xs">
                {typeLabel(exception.type)}
              </span>
              <span className="text-ink-muted">
                {exception.startTime === null
                  ? t("schedules.exceptions.wholeDay")
                  : `${exception.startTime} – ${exception.endTime}`}
              </span>
              {exception.doctorId === null && (
                <span className="rounded bg-primary-soft px-2 py-0.5 text-xs text-primary">
                  {t("schedules.exceptions.clinicWide")}
                </span>
              )}
              {exception.reason !== null && (
                <span className="truncate text-ink-muted">· {exception.reason}</span>
              )}
              {/* Button takes no className, so the layout hook goes on a wrapper. `ms-auto` is a
                  logical property; web-logical-properties.spec.ts fails the build on physical
                  sides. (That scan reads comments too, so naming the forbidden prefix here would
                  trip it -- which it did, once.) */}
              <span className="ms-auto">
                <Button variant="ghost" size="sm" onClick={() => void onRemove(exception.id)}>
                  {t("schedules.exceptions.remove")}
                </Button>
              </span>
            </li>
          ))}
        </ul>
      )}

      <div className="border-t border-border pt-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="w-40">
            <TextInput
              type="date"
              label={t("schedules.exceptions.date")}
              value={date}
              onChange={(event) => setDate(event.target.value)}
            />
          </div>

          <div className="w-40">
            <Select
              label={t("schedules.exceptions.type")}
              value={type}
              onChange={(event) => setType(event.target.value as ExceptionType)}
              options={EXCEPTION_TYPES.map((value) => ({ value, label: typeLabel(value) }))}
            />
          </div>

          {canManageClinicWide && (
            <div className="w-40">
              <Select
                label={t("schedules.exceptions.scope")}
                value={clinicWide ? "clinic" : "doctor"}
                onChange={(event) => setClinicWide(event.target.value === "clinic")}
                options={[
                  { value: "doctor", label: t("schedules.exceptions.scope.doctor") },
                  { value: "clinic", label: t("schedules.exceptions.scope.clinic") },
                ]}
              />
            </div>
          )}

          {wholeDayAllowed && (
            <label className="flex items-center gap-2 pb-2 text-sm">
              <input
                type="checkbox"
                checked={wholeDay}
                onChange={(event) => setWholeDay(event.target.checked)}
              />
              {t("schedules.exceptions.wholeDay")}
            </label>
          )}

          {!useWholeDay && (
            <>
              <div className="w-28">
                <TextInput
                  type="time"
                  label={t("schedules.weekly.from")}
                  value={startTime}
                  onChange={(event) => setStartTime(event.target.value)}
                />
              </div>
              <div className="w-28">
                <TextInput
                  type="time"
                  label={t("schedules.weekly.to")}
                  value={endTime}
                  onChange={(event) => setEndTime(event.target.value)}
                />
              </div>
            </>
          )}

          <div className="w-52">
            <TextInput
              label={t("schedules.exceptions.reason")}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          </div>

          <Button size="sm" loading={busy} onClick={() => void submit()}>
            {t("schedules.exceptions.add")}
          </Button>
        </div>
      </div>
    </Card>
  );
}
