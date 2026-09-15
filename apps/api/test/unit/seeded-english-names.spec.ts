import { CLINICS } from "../../prisma/seed/blueprint.ts";
import {
  FAMILY_NAMES,
  FEMALE_GIVEN_NAMES,
  MALE_GIVEN_NAMES,
  type EgyptianName,
} from "../../prisma/seed/arabic-names.ts";
import { generatePatients } from "../../prisma/seed/generate.ts";
import { Prng } from "../../prisma/seed/prng.ts";

/**
 * `full_name_en` is optional in the schema and mostly absent in reality: an Egyptian clinic
 * records Arabic, and an English name turns up only when somebody copied one off a passport
 * (SCHEMA-DECISIONS.md D19).
 *
 * The seed therefore gives it to a minority. The share is asserted here rather than left to
 * inspection because it is the kind of number that silently becomes 100% -- one refactor treating
 * the field as required, and every screen that renders `full_name_en` looks fine in review and is
 * empty against real data. **A majority of NULLs is the condition being tested for**, not an
 * incidental property of the fixture.
 *
 * The pairing test matters more than the share. An English name assembled from different name
 * parts than the Arabic one would describe a different person in the same row, and no type or
 * constraint anywhere would object.
 */

const ALL_NAMES: readonly EgyptianName[] = [...MALE_GIVEN_NAMES, ...FEMALE_GIVEN_NAMES, ...FAMILY_NAMES];

/** Arabic spelling -> the Latin spellings the name pools allow for it. */
const LATIN_FOR = new Map<string, Set<string>>();
for (const name of ALL_NAMES) {
  const existing = LATIN_FOR.get(name.ar) ?? new Set<string>();
  existing.add(name.en);
  LATIN_FOR.set(name.ar, existing);
}

function allSeededPatients(): ReturnType<typeof generatePatients> {
  return CLINICS.flatMap((clinic) => generatePatients(clinic, new Prng(clinic.randomSeed), 60_000_000));
}

describe("seeded patients: full_name_en", () => {
  const patients = allSeededPatients();
  const named = patients.filter((patient) => patient.fullNameEn !== null);

  test("the seed produces patients at all, so the ratios below mean something", () => {
    expect(patients.length).toBe(CLINICS.reduce((total, clinic) => total + clinic.patientCount, 0));
  });

  test("roughly one patient in five has an English name", () => {
    const share = named.length / patients.length;
    // A band, not a point: the share comes from a PRNG draw per patient, so pinning it exactly
    // would make this fail on any unrelated change to the generation order rather than on a
    // change to the intent. The band is tight enough to catch 0%, 50% or 100%.
    expect(share).toBeGreaterThan(0.12);
    expect(share).toBeLessThan(0.28);
  });

  test("most patients have none, which is the case the UI has to handle", () => {
    expect(patients.length - named.length).toBeGreaterThan(patients.length / 2);
  });

  test("the English name describes the same person as the Arabic one", () => {
    // Same number of parts, and each Latin part is the recorded spelling of the Arabic part in
    // the same position. A row where these drift apart would name two different people.
    // Family names are multi-word in both scripts ("عبد الرحمن" / "El Sayed"), so neither side can
    // be split on spaces and zipped -- the matcher consumes declared name components in order.
    const mismatched = named.filter((patient) => !describesSamePerson(patient.fullName, patient.fullNameEn ?? ""));
    expect(mismatched.map((patient) => `${patient.fullName} / ${patient.fullNameEn}`)).toEqual([]);
  });

  test("every Latin spelling used is one the name pools actually declare", () => {
    // Guards against a transliteration sneaking in here later. This column is what a human typed;
    // mechanically derived spellings belong in name_search_latin, not in full_name_en.
    const declared = new Set([...LATIN_FOR.values()].flatMap((set) => [...set]));
    const unknown = new Set<string>();
    for (const patient of named) {
      for (const word of patient.fullNameEn?.split(" ") ?? []) {
        if (![...declared].some((spelling) => spelling.split(" ").includes(word))) unknown.add(word);
      }
    }
    expect([...unknown]).toEqual([]);
  });
});

/**
 * True when both strings can be consumed, front to back, by the *same* sequence of declared name
 * components. Components are multi-word in both scripts, so this walks the two strings in step
 * rather than splitting and zipping them.
 *
 * Longest match first: "عبد الرحمن" must win over any shorter component that shares its prefix,
 * or the walk consumes the wrong number of words and reports a false mismatch.
 */
const BY_LENGTH: readonly EgyptianName[] = [...ALL_NAMES].sort((a, b) => b.ar.length - a.ar.length);

function describesSamePerson(arabic: string, latin: string): boolean {
  let arabicRest = arabic;
  let latinRest = latin;

  while (arabicRest.length > 0) {
    const component = BY_LENGTH.find(
      (name) =>
        (arabicRest === name.ar || arabicRest.startsWith(`${name.ar} `)) &&
        (latinRest === name.en || latinRest.startsWith(`${name.en} `)),
    );
    if (component === undefined) return false;
    arabicRest = arabicRest.slice(component.ar.length).trimStart();
    latinRest = latinRest.slice(component.en.length).trimStart();
  }

  return latinRest.length === 0;
}
