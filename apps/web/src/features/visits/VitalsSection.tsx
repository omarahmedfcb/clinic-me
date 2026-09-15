// Per-visit measurements, with the previous visit's values beside them. PR 7b.
// Units are labels, never inputs — a unit the user can type is a unit they can get wrong.

import { TextInput } from "../../design-system/fields.tsx";
import { ageInYears } from "../../domain/age.ts";
import { useLocale } from "../../i18n/locale-context.tsx";
import type { TranslationKey } from "../../i18n/strings.ts";
import {
  delta,
  isImplausible,
  parseVital,
  showsHeadCircumference,
  VITAL_UNITS,
  type VitalKey,
  type Vitals,
} from "../../domain/vitals.ts";

const ORDER: VitalKey[] = [
  "weightKg",
  "heightCm",
  "systolic",
  "diastolic",
  "temperatureC",
  "pulseBpm",
];

interface Props {
  vitals: Vitals;
  previous: Vitals;
  patientDateOfBirth: string | null;
  onChange: (next: Vitals) => void;
}

export function VitalsSection({ vitals, previous, patientDateOfBirth, onChange }: Props) {
  const { t } = useLocale();
  const age = ageInYears(patientDateOfBirth, new Date());
  const keys = showsHeadCircumference(age) ? [...ORDER, "headCircumferenceCm" as VitalKey] : ORDER;

  const set = (key: VitalKey, raw: string): void => {
    const value = parseVital(raw);
    const next = { ...vitals };
    // A cleared field is "not measured" and is removed, never stored as 0.
    if (value === null) delete next[key];
    else next[key] = value;
    onChange(next);
  };

  return (
    <section className="grid gap-3">
      <h2 className="text-sm font-semibold text-ink">{t("vitals.title")}</h2>
      <div className="grid gap-3 sm:grid-cols-3">
        {keys.map((key) => {
          const current = vitals[key];
          const change = delta(current, previous[key]);
          const warn = current !== undefined && isImplausible(key, current);
          return (
            <TextInput
              key={key}
              label={`${t(`vitals.${key}` as TranslationKey)} (${VITAL_UNITS[key]})`}
              numeric
              value={current === undefined ? "" : String(current)}
              error={warn ? t("vitals.implausible") : undefined}
              hint={
                previous[key] === undefined
                  ? undefined
                  : t("vitals.previous").replace(
                      "{value}",
                      change === null
                        ? String(previous[key])
                        : `${previous[key]} (${change > 0 ? "+" : ""}${change})`,
                    )
              }
              onChange={(event) => set(key, event.target.value)}
            />
          );
        })}
      </div>
    </section>
  );
}
