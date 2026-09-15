// What a complete patient record needs, derived on read and never stored. D26.
// Pure so the badge and any future report agree by construction rather than by inspection.

export interface IntakeFields {
  fullNameAr: string | null;
  phoneE164: string | null;
  dateOfBirth: Date | string | null;
  gender: string | null;
  nationality: string | null;
}

export type MissingIntakeField = keyof IntakeFields;

/**
 * The fields D26 requires at intake, missing from this row.
 *
 * Derived rather than stored because a stored flag needs a job to maintain it, and a flag nobody
 * recomputes is wrong the moment someone completes a record. The columns stay nullable, so this is
 * the only thing that distinguishes "recorded before the rule" from "recorded badly".
 */
export function missingIntakeFields(patient: IntakeFields): MissingIntakeField[] {
  const missing: MissingIntakeField[] = [];
  if (patient.fullNameAr === null || patient.fullNameAr.trim() === "") missing.push("fullNameAr");
  if (patient.phoneE164 === null || patient.phoneE164.trim() === "") missing.push("phoneE164");
  if (patient.dateOfBirth === null) missing.push("dateOfBirth");
  if (patient.gender === null || patient.gender.trim() === "") missing.push("gender");
  if (patient.nationality === null || patient.nationality.trim() === "") missing.push("nationality");
  return missing;
}

export function isIntakeIncomplete(patient: IntakeFields): boolean {
  return missingIntakeFields(patient).length > 0;
}
