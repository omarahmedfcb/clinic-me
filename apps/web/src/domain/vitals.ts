// Vitals recorded on a visit. Units are fixed and never entered — kg, cm, mmHg, °C, bpm.
// Pure: parsing and comparison only, so both the form and the server can agree on one shape.

export type VitalKey =
  | "weightKg"
  | "heightCm"
  | "systolic"
  | "diastolic"
  | "temperatureC"
  | "pulseBpm"
  | "headCircumferenceCm";

export type Vitals = Partial<Record<VitalKey, number>>;

/** The unit shown beside each field. A unit the user can type is a unit they can get wrong. */
export const VITAL_UNITS: Record<VitalKey, string> = {
  weightKg: "kg",
  heightCm: "cm",
  systolic: "mmHg",
  diastolic: "mmHg",
  temperatureC: "°C",
  pulseBpm: "bpm",
  headCircumferenceCm: "cm",
};

/**
 * Plausible ranges, used to warn — never to refuse.
 *
 * A clinic sees genuinely extreme values, and a form that rejects one makes the doctor write it in
 * a notes field where nothing can read it. The point is to catch a slipped decimal, not to argue.
 */
const PLAUSIBLE: Record<VitalKey, [number, number]> = {
  weightKg: [0.3, 400],
  heightCm: [20, 260],
  systolic: [50, 300],
  diastolic: [20, 200],
  temperatureC: [25, 45],
  pulseBpm: [20, 300],
  headCircumferenceCm: [20, 70],
};

/** Head circumference is a paediatric measurement — offered under 5, hidden above it. */
export const HEAD_CIRCUMFERENCE_MAX_AGE = 5;

export function showsHeadCircumference(ageYears: number | null): boolean {
  return ageYears !== null && ageYears < HEAD_CIRCUMFERENCE_MAX_AGE;
}

/** Empty string means "not measured" and is dropped, never stored as 0. */
export function parseVital(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

export function isImplausible(key: VitalKey, value: number): boolean {
  const [low, high] = PLAUSIBLE[key];
  return value < low || value > high;
}

/** How this visit's value compares with the previous one, for a screen to show a trend. */
export function delta(current: number | undefined, previous: number | undefined): number | null {
  if (current === undefined || previous === undefined) return null;
  return Number((current - previous).toFixed(2));
}
