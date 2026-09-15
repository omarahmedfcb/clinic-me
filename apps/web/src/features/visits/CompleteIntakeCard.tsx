// «ملف ناقص» on the visit screen: the doctor completes the three fields they can actually supply,
// through the same `PATCH /patients/:id` reception uses. Nothing else on the record is reachable.

import { useEffect, useState } from "react";
import { Button } from "../../design-system/Button.tsx";
import { Select, TextInput } from "../../design-system/fields.tsx";
import {
  EMPTY_BIRTH_DATE,
  isoFromParts,
  partsFromIso,
  type BirthDateParts,
  type BirthDateProblem,
} from "../../domain/birth-date.ts";
import { useLocale } from "../../i18n/locale-context.tsx";
import { BirthDateField } from "../patients/BirthDateField.tsx";
import { updatePatient } from "../patients/patients-api.ts";

type AuthFetch = (path: string, init?: RequestInit) => Promise<Response>;

/**
 * **Three fields, and the list is the point rather than a starting set.**
 *
 * The doctor has the patient in front of them, so date of birth, sex and a working phone number are
 * the ones they can answer and the ones a clinical record is unusable without. Address, national id
 * and the name are reception's: asking a doctor mid-consultation to correct a spelling is how a
 * consultation becomes data entry. `visit-intake-fields-are-limited.spec.ts` fails the build if a
 * fourth field appears here.
 */
const EDITABLE = ["dateOfBirth", "gender", "phoneE164"] as const;

export function CompleteIntakeCard({
  authFetch,
  patientId,
  missing,
  dateOfBirth,
  gender,
  phoneE164,
  onSaved,
}: {
  authFetch: AuthFetch;
  patientId: string;
  /** From the summary, derived server-side (D26). Only these three are offered. */
  missing: string[] | undefined;
  dateOfBirth: string | null;
  gender: string | null;
  phoneE164: string;
  onSaved: () => void;
}) {
  const { t } = useLocale();
  const [open, setOpen] = useState(false);
  const [dobParts, setDobParts] = useState<BirthDateParts>(EMPTY_BIRTH_DATE);
  const [dobIso, setDobIso] = useState("");
  const [dobProblem, setDobProblem] = useState<BirthDateProblem | null>(null);
  const [sex, setSex] = useState(gender ?? "");
  const [phone, setPhone] = useState(phoneE164);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDobParts(partsFromIso(dateOfBirth));
  }, [dateOfBirth]);

  useEffect(() => {
    const parsed = isoFromParts(dobParts, new Date());
    setDobProblem(parsed.ok ? null : parsed.problem);
    setDobIso(parsed.ok ? parsed.iso : "");
  }, [dobParts]);

  // `?? []` because a built client can meet an older API that has no such field, and a header that
  // throws takes the whole visit screen with it — the lesson `CoverageBadge` already records.
  const offered = EDITABLE.filter((field) => (missing ?? []).includes(field));
  if (offered.length === 0) return null;

  async function save(): Promise<void> {
    setSaving(true);
    setError(null);
    const result = await updatePatient(authFetch, patientId, {
      ...(dobIso === "" ? {} : { dateOfBirth: dobIso }),
      ...(sex === "" ? {} : { gender: sex }),
      ...(phone.trim() === "" ? {} : { phoneE164: phone.trim() }),
    });
    setSaving(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setOpen(false);
    onSaved();
  }

  return (
    <div className="mt-2" data-testid="complete-intake">
      <p className="flex flex-wrap items-center gap-2 text-xs text-warning">
        <span className="rounded-full bg-warning-soft px-2 py-0.5">{t("patients.incomplete")}</span>
        <Button size="sm" variant="ghost" data-testid="complete-intake-open" onClick={() => setOpen(!open)}>
          {t("intake.completeHere")}
        </Button>
      </p>

      {open && (
        <div className="mt-2 grid gap-3 rounded-lg border border-border p-3 sm:grid-cols-3">
          {offered.includes("dateOfBirth") && (
            <BirthDateField parts={dobParts} onChange={setDobParts} iso={dobIso} problem={dobProblem} />
          )}
          {offered.includes("gender") && (
            <Select
              label={t("intake.field.gender")}
              value={sex}
              placeholder={t("intake.field.gender")}
              options={[
                { value: "MALE", label: t("intake.gender.MALE") },
                { value: "FEMALE", label: t("intake.gender.FEMALE") },
              ]}
              data-testid="intake-gender"
              onChange={(event) => setSex(event.target.value)}
            />
          )}
          {offered.includes("phoneE164") && (
            <TextInput
              label={t("intake.field.phone")}
              numeric
              inputMode="tel"
              value={phone}
              data-testid="intake-phone"
              onChange={(event) => setPhone(event.target.value)}
            />
          )}

          <div className="sm:col-span-3">
            <Button size="sm" loading={saving} data-testid="complete-intake-save" onClick={() => void save()}>
              {t("intake.save")}
            </Button>
          </div>

          {error !== null && (
            <p role="alert" className="text-xs text-danger sm:col-span-3" data-testid="complete-intake-error">
              {error}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
