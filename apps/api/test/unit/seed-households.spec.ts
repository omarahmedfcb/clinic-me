import { CLINICS } from "../../prisma/seed/blueprint.ts";
import { generatePatients, type GeneratedPatient } from "../../prisma/seed/generate.ts";
import { Prng } from "../../prisma/seed/prng.ts";

/**
 * **A quarter of seeded patients share a household number**, ruled 2026-09-18.
 *
 * One phone per family is the Egyptian norm — a mother books for a child on her own phone — and the
 * seed modelled the opposite: 120 patients, 120 contacts, every relationship `SELF`. That made the
 * bot's household lookup untestable against review data and showed every desk screen a shape the
 * pilot clinics will not have.
 *
 * Asserted as a band rather than a number: the exact count follows from the PRNG and the household
 * sizes, and pinning it would turn any change to either into a failure that says nothing.
 */
function patientsFor(clinicIndex: number): GeneratedPatient[] {
  const clinic = CLINICS[clinicIndex];
  if (clinic === undefined) throw new Error(`no clinic at ${clinicIndex}`);
  return generatePatients(clinic, new Prng(clinic.randomSeed), 60_000_000);
}

/** Members by contact, which is what "a household" means in the schema. */
function households(patients: GeneratedPatient[]): GeneratedPatient[][] {
  const byContact = new Map<string, GeneratedPatient[]>();
  for (const patient of patients) {
    byContact.set(patient.contactId, [...(byContact.get(patient.contactId) ?? []), patient]);
  }
  return [...byContact.values()].filter((members) => members.length > 1);
}

describe("the seed models households, not 120 people with 120 phones", () => {
  test("between a fifth and a third of patients live in one", () => {
    for (let index = 0; index < CLINICS.length; index += 1) {
      const patients = patientsFor(index);
      const inHousehold = households(patients).flat().length;
      const share = inHousehold / patients.length;
      expect(share).toBeGreaterThanOrEqual(0.2);
      expect(share).toBeLessThanOrEqual(0.3);
    }
  });

  test("a household shares one contact, one number, one family name", () => {
    for (let index = 0; index < CLINICS.length; index += 1) {
      for (const members of households(patientsFor(index))) {
        expect(new Set(members.map((member) => member.phoneE164)).size).toBe(1);
        expect(new Set(members.map((member) => member.fullName.split(" ").at(-1))).size).toBe(1);
      }
    }
  });

  test("exactly one member is SELF, and the others are a real mix", () => {
    const seen = new Set<string>();
    for (let index = 0; index < CLINICS.length; index += 1) {
      for (const members of households(patientsFor(index))) {
        expect(members.filter((member) => member.relationshipToContact === "SELF")).toHaveLength(1);
        for (const member of members) seen.add(member.relationshipToContact);
      }
    }
    // A seed where every non-head were a CHILD would pass the two tests above and still show the
    // desk one shape of family.
    expect([...seen].sort()).toEqual(["CHILD", "PARENT", "SELF", "SPOUSE"]);
  });

  test("patients outside a household keep their own number and SELF", () => {
    for (let index = 0; index < CLINICS.length; index += 1) {
      const patients = patientsFor(index);
      const shared = new Set(households(patients).flat().map((member) => member.id));
      const alone = patients.filter((patient) => !shared.has(patient.id));
      expect(alone.length).toBeGreaterThan(0);
      expect(alone.every((patient) => patient.relationshipToContact === "SELF")).toBe(true);
      expect(new Set(alone.map((patient) => patient.phoneE164)).size).toBe(alone.length);
    }
  });

  test("the same reference date produces the same households", () => {
    // The seed's whole determinism claim, applied to the part of it added here: a household that
    // moved between runs would make "the mother on +2010…" mean a different person each morning.
    const shape = (patients: GeneratedPatient[]): string =>
      households(patients)
        .map((members) => members.map((member) => `${member.relationshipToContact}:${member.fullName}`).join("|"))
        .sort()
        .join("\n");
    expect(shape(patientsFor(0))).toBe(shape(patientsFor(0)));
    expect(shape(patientsFor(0))).not.toBe(shape(patientsFor(1)));
  });
});
