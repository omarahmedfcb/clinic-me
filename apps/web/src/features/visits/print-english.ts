// Printed documents are English whatever the interface language is — Q45. These labels are
// deliberately constants and not `t()` keys: a printed sheet must not change with the UI locale.

/**
 * Why the sheets do not go through the translator.
 *
 * `t()` answers in the language the user is reading the application in, which is exactly what a
 * printed document must not do — the ruling is that the paper is always English, for a patient who
 * may take it abroad, a pharmacy that reads Latin trade names, and an employer receiving a sick
 * note. Passing these through the catalogue would make the paper follow the screen, and the bug
 * would be invisible to anyone working in English.
 */
export const EN = {
  prescription: "PRESCRIPTION",
  report: "MEDICAL REPORT",
  investigations: "INVESTIGATIONS REQUEST",
  sickLeave: "SICK LEAVE CERTIFICATE",

  patient: "Patient",
  name: "Name",
  fileNo: "File No.",
  dob: "Date of birth",
  age: "Age",
  sex: "Sex",
  phone: "Phone",

  visit: "Visit",
  date: "Date",
  time: "Time",
  doctor: "Doctor",
  licence: "Licence No.",
  syndicate: "Syndicate No.",

  no: "#",
  medication: "Medication",
  strength: "Strength",
  form: "Form",
  dosage: "Dosage & instructions",
  duration: "Duration",
  quantity: "Qty",

  followUp: "Follow-up",
  notes: "Notes",
  complaint: "Complaint",
  diagnosis: "Diagnosis",
  plan: "Treatment plan",
  signature: "Signature",

  nothingPrescribed: "No medication prescribed.",
  nothingRequested: "No investigations requested.",
  notRecorded: "Not recorded",

  sickLeaveDays: "Days",
  sickLeaveFrom: "From",
  sickLeaveTo: "To",
  sickLeaveSentence:
    "This is to certify that the patient named above is medically unfit for work and requires sick leave for the period stated.",

  years: "years",
  male: "Male",
  female: "Female",
} as const;

/**
 * The name that goes on a sheet: the English name when one was recorded, otherwise the name exactly
 * as stored, which is usually Arabic. It is never transliterated -- a machine's guess at a person's name is not
 * something to hand across a counter.
 */
export function printedPatientName(patient: {
  fullNameEn: string | null;
  fullNameAr: string;
}): { name: string; source: "english" | "arabic" } {
  const english = patient.fullNameEn?.trim() ?? "";
  if (english !== "") return { name: english, source: "english" };
  return { name: patient.fullNameAr, source: "arabic" };
}

/**
 * The clinic's own file number for this patient.
 *
 * Q45 printed an eight-character reference derived from the patient's UUID, because no file number
 * existed and a hole in the patient block was worse. Phase 5 PR 2 added the real thing — per
 * clinic, sequential, allocated by a trigger — so the sheet prints what the receptionist reads
 * down a phone. The UUID fallback stays for a payload from an API older than that column: a sheet
 * that cannot identify its patient is not a document.
 */
export function fileReference(patient: { fileNumber?: number | null; patientId: string }): string {
  const number = patient.fileNumber;
  if (typeof number === "number" && Number.isFinite(number)) return String(number);
  return patient.patientId.replace(/-/g, "").slice(-8).toUpperCase();
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * `09 Sep 2026`, written out rather than left to `Intl`.
 *
 * `toLocaleDateString("en-GB", { month: "short" })` returns "Sept" on Node's ICU and "Sep" in some
 * browsers — so the same visit would print differently depending on where the page ran, which for a
 * document a patient carries to an employer or an airport is not an acceptable variance. A printed
 * date must be one string, decided here.
 *
 * Read in UTC because a DATE column arrives as UTC midnight, and `getDate()` in a negative offset
 * would print the day before.
 */
export function printedDate(iso: string | null): string {
  if (iso === null) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${day} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

/** Local time, unlike the date: the visit happened at a wall-clock time the clinic recognises. */
export function printedTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/** The day a certificate's leave ends: the first day plus the days granted, inclusive. */
export function sickLeaveEnd(from: string, days: number): string {
  const start = new Date(`${from}T00:00:00.000Z`);
  if (Number.isNaN(start.getTime())) return "";
  // Inclusive: three days from Monday ends on Wednesday, not Thursday. An employer reads the two
  // dates and counts them, so an off-by-one here is a day of pay.
  start.setUTCDate(start.getUTCDate() + days - 1);
  return printedDate(start.toISOString());
}

export function printedSex(gender: string | null): string {
  if (gender === "MALE") return EN.male;
  if (gender === "FEMALE") return EN.female;
  return "";
}
