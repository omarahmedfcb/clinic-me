// Reception editing the record it already reads — Q42. Personal and contact details only.
// Nothing clinical is reachable from here: `patients` carries no clinical column, by design.

import { useEffect, useState } from "react";
import { Button } from "../../design-system/Button.tsx";
import { Card } from "../../design-system/display.tsx";
import { Select, TextInput } from "../../design-system/fields.tsx";
import {
  EMPTY_BIRTH_DATE,
  isoFromParts,
  partsFromIso,
  type BirthDateParts,
  type BirthDateProblem,
} from "../../domain/birth-date.ts";
import { useLocale } from "../../i18n/locale-context.tsx";
import { BirthDateField } from "./BirthDateField.tsx";
import { updatePatient, type PatientProfile } from "./patients-api.ts";

type AuthFetch = (path: string, init?: RequestInit) => Promise<Response>;

interface Props {
  authFetch: AuthFetch;
  patient: PatientProfile;
  onSaved: () => void;
  onCancel: () => void;
}

export function EditPatientCard({ authFetch, patient, onSaved, onCancel }: Props) {
  const { t } = useLocale();
  const [fullNameAr, setFullNameAr] = useState(patient.fullNameAr);
  const [fullNameEn, setFullNameEn] = useState(patient.fullNameEn ?? "");
  const [phoneE164, setPhoneE164] = useState(patient.phoneE164);
  const [secondaryPhone, setSecondaryPhone] = useState(patient.secondaryPhone ?? "");
  const [gender, setGender] = useState(patient.gender ?? "");
  const [nationalId, setNationalId] = useState(patient.nationalId ?? "");
  const [address, setAddress] = useState(patient.address ?? "");
  const [dobParts, setDobParts] = useState<BirthDateParts>(EMPTY_BIRTH_DATE);
  const [dateOfBirth, setDateOfBirth] = useState("");
  const [dobProblem, setDobProblem] = useState<BirthDateProblem | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDobParts(partsFromIso(patient.dateOfBirth));
  }, [patient.dateOfBirth]);

  useEffect(() => {
    const parsed = isoFromParts(dobParts, new Date());
    setDobProblem(parsed.ok ? null : parsed.problem);
    setDateOfBirth(parsed.ok ? parsed.iso : "");
  }, [dobParts]);

  async function save(): Promise<void> {
    setSaving(true);
    setError(null);
    // `""` means "clear it", which is `null` on the wire and is not the same as omitting the key.
    // The badge is derived from what is stored, so completing these fields clears it by itself.
    const result = await updatePatient(authFetch, patient.id, {
      fullNameAr,
      fullNameEn: fullNameEn.trim() === "" ? null : fullNameEn,
      phoneE164,
      secondaryPhone: secondaryPhone.trim() === "" ? null : secondaryPhone,
      gender: gender === "" ? null : gender,
      ...(dateOfBirth === "" ? {} : { dateOfBirth }),
      nationalId: nationalId.trim() === "" ? null : nationalId,
      address: address.trim() === "" ? null : address,
    });
    setSaving(false);
    if (result.ok) {
      onSaved();
      return;
    }
    setError(result.message);
  }

  return (
    <Card title={t("patients.detail.edit")}>
      <div className="grid gap-4" data-testid="edit-patient">
        {error !== null && (
          <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
            {error}
          </p>
        )}

        <TextInput
          label={t("intake.field.fullNameAr")}
          required
          value={fullNameAr}
          onChange={(event) => setFullNameAr(event.target.value)}
        />
        <TextInput
          label={t("intake.field.fullNameEn")}
          value={fullNameEn}
          onChange={(event) => setFullNameEn(event.target.value)}
        />
        <TextInput
          label={t("intake.field.phone")}
          numeric
          required
          value={phoneE164}
          onChange={(event) => setPhoneE164(event.target.value)}
        />
        <TextInput
          label={t("intake.field.secondaryPhone")}
          numeric
          value={secondaryPhone}
          onChange={(event) => setSecondaryPhone(event.target.value)}
        />

        <BirthDateField
          parts={dobParts}
          onChange={setDobParts}
          iso={dateOfBirth}
          problem={dobProblem}
        />

        <Select
          label={t("intake.field.gender")}
          value={gender}
          placeholder={t("intake.field.gender")}
          options={[
            { value: "MALE", label: t("intake.gender.MALE") },
            { value: "FEMALE", label: t("intake.gender.FEMALE") },
          ]}
          onChange={(event) => setGender(event.target.value)}
        />
        <TextInput
          label={t("intake.field.nationalId")}
          numeric
          value={nationalId}
          onChange={(event) => setNationalId(event.target.value)}
        />
        <TextInput
          label={t("patients.detail.address")}
          value={address}
          onChange={(event) => setAddress(event.target.value)}
        />

        <div className="flex items-center gap-2">
          <Button data-testid="save-patient" loading={saving} onClick={() => void save()}>
            {t("settings.save")}
          </Button>
          <Button variant="secondary" onClick={onCancel}>
            {t("doctors.cancel")}
          </Button>
        </div>
      </div>
    </Card>
  );
}
