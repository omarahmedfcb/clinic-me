import { readFileSync } from "node:fs";
import path from "node:path";
import { stripComments } from "../../scripts/route-capabilities.ts";

/**
 * **The doctor may complete three intake fields from the visit screen, and only three.**
 *
 * The founder's review of #99: date of birth, sex and phone, because those are what a doctor with
 * the patient in front of them can answer and what a clinical record is unusable without. The rest
 * of the file — name, national id, address, nationality, referral source — is reception's work, and
 * a fourth field appearing here is how a consultation quietly becomes data entry.
 *
 * The screen's own spec proves the patch carries only those keys. This proves the **form** offers
 * only those fields, which is the half a request-shape assertion cannot see: a field rendered and
 * bound to state is a field someone will wire up, and the two checks fail for different reasons.
 */

const CARD = path.resolve(
  __dirname,
  "..",
  "..",
  "..",
  "web",
  "src",
  "features",
  "visits",
  "CompleteIntakeCard.tsx",
);

const source = stripComments(readFileSync(CARD, "utf8"));

/** Every field `PATCH /patients/:id` accepts, from `PatientPatch`. */
const ALL_PATIENT_FIELDS = [
  "fullNameAr",
  "fullNameEn",
  "phoneE164",
  "secondaryPhone",
  "gender",
  "dateOfBirth",
  "nationalId",
  "address",
] as const;

const ALLOWED = ["dateOfBirth", "gender", "phoneE164"] as const;

describe("the doctor's intake form is limited to three fields", () => {
  test("the guard can see the file it is guarding, so an empty pass is impossible", () => {
    expect(source).toContain("CompleteIntakeCard");
    expect(source).toContain("updatePatient");
  });

  test("the editable list is exactly date of birth, sex and phone", () => {
    const declared = /const EDITABLE = \[([^\]]*)\]/.exec(source)?.[1] ?? "";
    const fields = [...declared.matchAll(/"([^"]+)"/g)].map((match) => match[1] as string);
    expect(fields.sort()).toEqual([...ALLOWED].sort());
  });

  test("no other patient field is named anywhere in the form", () => {
    // Named rather than counted: a new field added to the JSX without touching `EDITABLE` would
    // still render, still bind, and still be sent the moment somebody adds it to the patch.
    const forbidden = ALL_PATIENT_FIELDS.filter(
      (field) => !(ALLOWED as readonly string[]).includes(field) && source.includes(field),
    );
    expect(forbidden).toEqual([]);
  });
});
