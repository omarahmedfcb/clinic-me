// Three selects and the age beside them — Q31 as amended 2026-09-09.
// The age is still how a receptionist notices they picked the wrong decade; only the input changed.

import { Select } from "../../design-system/fields.tsx";
import { ageInYears } from "../../domain/age.ts";
import {
  birthDayOptions,
  birthYearOptions,
  MONTH_NUMBERS,
  type BirthDateParts,
  type BirthDateProblem,
} from "../../domain/birth-date.ts";
import { useLocale } from "../../i18n/locale-context.tsx";
import type { TranslationKey } from "../../i18n/strings.ts";

interface Props {
  parts: BirthDateParts;
  onChange: (parts: BirthDateParts) => void;
  /** The ISO value the parts resolve to, or "" — used only for the age shown beside the selects. */
  iso: string;
  problem: BirthDateProblem | null;
  required?: boolean;
  /** Shown when the field is required and empty, so two errors never stack on one control. */
  requiredError?: string | undefined;
}

export function BirthDateField({ parts, onChange, iso, problem, required, requiredError }: Props) {
  const { t } = useLocale();
  const age = ageInYears(iso === "" ? null : iso, new Date());

  const error =
    problem === null || problem === "INCOMPLETE"
      ? requiredError
      : t(`intake.dob.${problem}` as TranslationKey);

  return (
    <div className="grid gap-1">
      <div className="grid grid-cols-3 gap-2">
        <Select
          label={t("intake.dob.day")}
          required={required}
          value={parts.day}
          placeholder={t("intake.dob.day")}
          // Recomputed from the month and year, so 31 is not offered for April and 29 only in a
          // leap year. A day already chosen that the new month cannot hold is cleared rather than
          // silently rolled forward into the next month.
          options={birthDayOptions(parts.month, parts.year).map((day) => ({ value: day, label: day }))}
          onChange={(event) => onChange({ ...parts, day: event.target.value })}
        />
        <Select
          label={t("intake.dob.month")}
          required={required}
          value={parts.month}
          placeholder={t("intake.dob.month")}
          options={MONTH_NUMBERS.map((month) => ({
            value: month,
            label: t(`intake.month.${month}` as TranslationKey),
          }))}
          onChange={(event) => {
            const month = event.target.value;
            const days = birthDayOptions(month, parts.year);
            onChange({
              ...parts,
              month,
              day: days.includes(parts.day) ? parts.day : "",
            });
          }}
        />
        <Select
          label={t("intake.dob.year")}
          required={required}
          value={parts.year}
          placeholder={t("intake.dob.year")}
          // Descending from the current year: a birthday is far more often recent than a century
          // ago, and a list starting at 1906 makes the common case the longest scroll.
          options={birthYearOptions(new Date()).map((year) => ({ value: year, label: year }))}
          onChange={(event) => {
            const year = event.target.value;
            const days = birthDayOptions(parts.month, year);
            onChange({ ...parts, year, day: days.includes(parts.day) ? parts.day : "" });
          }}
        />
      </div>

      {error !== undefined ? (
        <p className="text-xs text-danger">{error}</p>
      ) : age !== null ? (
        <p className="text-xs text-ink-muted" data-testid="dob-age">
          {t("intake.dob.age").replace("{age}", String(age))}
        </p>
      ) : null}
    </div>
  );
}
