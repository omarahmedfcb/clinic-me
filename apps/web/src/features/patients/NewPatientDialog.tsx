// Patient intake. D26 (required fields), D27 (national ID), D28 (households).
// The national ID fills fields and never overwrites silently — a disagreement warns, it does not block.

import { useEffect, useState } from "react";
import { Button } from "../../design-system/Button.tsx";
import { Modal } from "../../design-system/overlays.tsx";
import { Select, TextInput, Textarea } from "../../design-system/fields.tsx";
import { useLocale } from "../../i18n/locale-context.tsx";
import type { TranslationKey } from "../../i18n/strings.ts";
import { useSession } from "../auth/session.tsx";
import { countries, DEFAULT_NATIONALITY } from "../../domain/countries.ts";
import {
  EMPTY_BIRTH_DATE,
  isoFromParts,
  partsFromIso,
  type BirthDateParts,
  type BirthDateProblem,
} from "../../domain/birth-date.ts";
import { BirthDateField } from "./BirthDateField.tsx";
import {
  nationalIdDisagreements,
  parseEgyptianNationalId,
} from "../../domain/egyptian-national-id.ts";
import {
  createPatient,
  loadHousehold,
  type Household,
  type NewPatient,
  type Relationship,
} from "./patients-api.ts";

const RELATIONSHIPS: Relationship[] = ["SELF", "SPOUSE", "CHILD", "PARENT", "SIBLING", "OTHER"];

interface Props {
  /** Prefills the Arabic name when intake is reached from a search that found nothing. */
  initialName?: string;
  initialPhone?: string;
  onClose: () => void;
  onCreated: (patientId: string) => void;
  onOpenExisting?: (patientId: string) => void;
}

export function NewPatientDialog({
  initialName = "",
  initialPhone = "",
  onClose,
  onCreated,
  onOpenExisting,
}: Props) {
  const { t, locale } = useLocale();
  const { authFetch } = useSession();

  const [fullNameAr, setFullNameAr] = useState(initialName);
  const [fullNameEn, setFullNameEn] = useState("");
  const [phoneE164, setPhone] = useState(initialPhone);
  const [secondaryPhone, setSecondaryPhone] = useState("");
  /** What the three selects hold, and what the server gets (ISO). Q31 as amended 2026-09-09. */
  const [dobParts, setDobParts] = useState<BirthDateParts>(EMPTY_BIRTH_DATE);
  const [dateOfBirth, setDateOfBirth] = useState("");
  const [dobProblem, setDobProblem] = useState<BirthDateProblem | null>(null);
  const [gender, setGender] = useState("");
  const [nationality, setNationality] = useState(DEFAULT_NATIONALITY);
  const [nationalId, setNationalId] = useState("");
  const [passportNumber, setPassportNumber] = useState("");
  const [governorate, setGovernorate] = useState("");
  const [address, setAddress] = useState("");
  const [email, setEmail] = useState("");
  const [referralSource, setReferralSource] = useState("");
  const [notes, setNotes] = useState("");
  const [relationship, setRelationship] = useState<Relationship>("SELF");

  const [household, setHousehold] = useState<Household | null>(null);
  const [nidProblem, setNidProblem] = useState(false);
  const [nidFilled, setNidFilled] = useState(false);
  const [mismatch, setMismatch] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<TranslationKey | null>(null);
  const [showRequired, setShowRequired] = useState(false);

  // The three parts drive the ISO value. "Not finished choosing" is not a format error — the
  // required-field message covers that, and two errors on one control is noise.
  useEffect(() => {
    const parsed = isoFromParts(dobParts, new Date());
    setDobProblem(parsed.ok ? null : parsed.problem);
    setDateOfBirth(parsed.ok ? parsed.iso : "");
  }, [dobParts]);

  const isEgyptian = nationality === "EG";
  const countryOptions = countries(locale).map((c) => ({ value: c.code, label: c.name }));

  // D28: ask who already answers to this number, before writing anything.
  useEffect(() => {
    const digits = phoneE164.trim();
    if (digits.length < 8) {
      setHousehold(null);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      void loadHousehold(authFetch, digits).then((found) => {
        if (!cancelled) setHousehold(found);
      });
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [authFetch, phoneE164]);

  // D27: the ID is evidence. It fills empty fields, and disagreements warn rather than overwrite.
  useEffect(() => {
    if (!isEgyptian || nationalId.trim() === "") {
      setNidProblem(false);
      setNidFilled(false);
      setMismatch([]);
      return;
    }
    const parsed = parseEgyptianNationalId(nationalId);
    if (!parsed.ok) {
      setNidProblem(nationalId.trim().length >= 14);
      setNidFilled(false);
      setMismatch([]);
      return;
    }
    setNidProblem(false);
    setMismatch(nationalIdDisagreements(parsed.facts, { dateOfBirth, gender }));
    let filled = false;
    if (dateOfBirth === "") {
      // Through the visible field, so the filled value is one a person can then correct (D27).
      setDobParts(partsFromIso(parsed.facts.dateOfBirth));
      filled = true;
    }
    if (gender === "") {
      setGender(parsed.facts.gender);
      filled = true;
    }
    if (governorate === "") {
      setGovernorate(parsed.facts.governorate);
      filled = true;
    }
    if (filled) setNidFilled(true);
  }, [nationalId, isEgyptian, dateOfBirth, gender, governorate]);

  const missing =
    fullNameAr.trim() === "" ||
    phoneE164.trim() === "" ||
    dateOfBirth === "" ||
    gender === "" ||
    nationality === "";

  async function save(): Promise<void> {
    if (missing) {
      setShowRequired(true);
      return;
    }
    setSaving(true);
    setError(null);
    const body: NewPatient = {
      fullNameAr: fullNameAr.trim(),
      phoneE164: phoneE164.trim(),
      dateOfBirth,
      gender: gender as "MALE" | "FEMALE",
      nationality,
      relationshipToContact: relationship,
      ...(fullNameEn.trim() === "" ? {} : { fullNameEn: fullNameEn.trim() }),
      ...(secondaryPhone.trim() === "" ? {} : { secondaryPhone: secondaryPhone.trim() }),
      ...(isEgyptian && nationalId.trim() !== "" ? { nationalId: nationalId.trim() } : {}),
      ...(!isEgyptian && passportNumber.trim() !== "" ? { passportNumber: passportNumber.trim() } : {}),
      ...(governorate.trim() === "" ? {} : { governorate: governorate.trim() }),
      ...(address.trim() === "" ? {} : { address: address.trim() }),
      ...(email.trim() === "" ? {} : { email: email.trim() }),
      ...(referralSource.trim() === "" ? {} : { referralSource: referralSource.trim() }),
      ...(notes.trim() === "" ? {} : { notes: notes.trim() }),
    };
    const result = await createPatient(authFetch, body);
    setSaving(false);
    if (result.ok) {
      onCreated(result.patient.id);
      return;
    }
    setError(
      result.reason === "DUPLICATE_ID"
        ? "intake.duplicateId"
        : result.reason === "INVALID"
          ? "intake.invalid"
          : "intake.failed",
    );
  }

  const required = (value: string) => (showRequired && value.trim() === "" ? t("intake.required") : undefined);

  return (
    <Modal
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={t("intake.title")}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            {t("intake.cancel")}
          </Button>
          <Button loading={saving} onClick={() => void save()}>
            {saving ? t("intake.saving") : t("intake.save")}
          </Button>
        </div>
      }
    >
      <div className="grid gap-4">
        <TextInput
          label={t("intake.field.fullNameAr")}
          required
          value={fullNameAr}
          error={required(fullNameAr)}
          onChange={(e) => setFullNameAr(e.target.value)}
        />
        <TextInput
          label={t("intake.field.phone")}
          required
          numeric
          value={phoneE164}
          error={required(phoneE164)}
          onChange={(e) => setPhone(e.target.value)}
        />

        {household !== null && (
          <div
            data-testid="household-found"
            className="rounded-lg bg-surface-sunken px-3 py-2 text-sm"
          >
            <p className="text-ink-muted">{t("intake.household.found")}</p>
            <ul className="mt-1 grid gap-1">
              {household.members.map((member) => (
                <li key={member.id} className="flex items-center justify-between gap-2">
                  <span>{member.fullNameAr}</span>
                  {onOpenExisting !== undefined && (
                    <Button size="sm" variant="secondary" onClick={() => onOpenExisting(member.id)}>
                      {t("intake.household.openExisting")}
                    </Button>
                  )}
                </li>
              ))}
            </ul>
            <p className="mt-2 text-xs text-ink-subtle">{t("intake.household.addMember")}</p>
          </div>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          {/* Three selects (Q31 as amended 2026-09-09). The age beside them is unchanged and is
              still how a wrong decade gets noticed; a select simply cannot produce 31/02. */}
          <BirthDateField
            parts={dobParts}
            onChange={setDobParts}
            iso={dateOfBirth}
            problem={dobProblem}
            required
            requiredError={required(dateOfBirth)}
          />
          <Select
            label={t("intake.field.gender")}
            required
            value={gender}
            error={required(gender)}
            options={[
              { value: "MALE", label: t("intake.gender.MALE") },
              { value: "FEMALE", label: t("intake.gender.FEMALE") },
            ]}
            placeholder="—"
            onChange={(e) => setGender(e.target.value)}
          />
          <Select
            label={t("intake.field.nationality")}
            required
            value={nationality}
            options={countryOptions}
            onChange={(e) => setNationality(e.target.value)}
          />
          <Select
            label={t("intake.field.relationship")}
            value={relationship}
            options={RELATIONSHIPS.map((r) => ({
              value: r,
              label: t(`intake.rel.${r}` as TranslationKey),
            }))}
            onChange={(e) => setRelationship(e.target.value as Relationship)}
          />
        </div>

        {isEgyptian ? (
          <TextInput
            label={t("intake.field.nationalId")}
            numeric
            value={nationalId}
            error={nidProblem ? t("intake.nid.invalid") : undefined}
            hint={nidFilled && !nidProblem ? t("intake.nid.filled") : undefined}
            onChange={(e) => setNationalId(e.target.value)}
          />
        ) : (
          <TextInput
            label={t("intake.field.passportNumber")}
            value={passportNumber}
            onChange={(e) => setPassportNumber(e.target.value)}
          />
        )}

        {mismatch.length > 0 && (
          <p data-testid="nid-mismatch" className="rounded-lg bg-warning-soft px-3 py-2 text-sm text-ink">
            {t("intake.nid.mismatch")}
          </p>
        )}

        <details className="rounded-lg border border-border px-3 py-2">
          <summary className="cursor-pointer text-sm text-ink-muted">
            {t("intake.section.optional")}
          </summary>
          <div className="mt-3 grid gap-4 sm:grid-cols-2">
            <TextInput
              label={t("intake.field.fullNameEn")}
              value={fullNameEn}
              onChange={(e) => setFullNameEn(e.target.value)}
            />
            <TextInput
              label={t("intake.field.secondaryPhone")}
              numeric
              value={secondaryPhone}
              onChange={(e) => setSecondaryPhone(e.target.value)}
            />
            <TextInput
              label={t("intake.field.governorate")}
              value={governorate}
              onChange={(e) => setGovernorate(e.target.value)}
            />
            <TextInput
              label={t("intake.field.email")}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            <TextInput
              label={t("intake.field.address")}
              value={address}
              onChange={(e) => setAddress(e.target.value)}
            />
            <TextInput
              label={t("intake.field.referralSource")}
              value={referralSource}
              onChange={(e) => setReferralSource(e.target.value)}
            />
          </div>
          <div className="mt-4">
            <Textarea
              label={t("intake.field.notes")}
              rows={3}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </div>
        </details>

        {error !== null && (
          <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
            {t(error)}
          </p>
        )}

      </div>
    </Modal>
  );
}
