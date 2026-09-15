// Kinship between two patients. Q30 — bidirectional, and distinct from D28's shared-phone household.
// A son may have his own number and still be a son; a household is a phone, this is a family.

export const KINSHIPS = ["HUSBAND", "WIFE", "SON", "DAUGHTER", "FATHER", "MOTHER"] as const;

export type Kinship = (typeof KINSHIPS)[number];

/**
 * What the *other* person is, given what this person is to them.
 *
 * Bidirectional means both rows exist, and the reciprocal is derived rather than asked twice: a
 * receptionist told once that Ali is Mona's son should not then be asked what Mona is to Ali.
 *
 * The parent case needs the other person's sex, which is why it is a parameter. `null` for an
 * unknown sex is deliberate — a legacy record with no sex recorded gets no guessed reciprocal, and
 * the caller stores the neutral label rather than inventing a father.
 */
export function reciprocalOf(relation: Kinship, otherGender: string | null): Kinship | null {
  switch (relation) {
    case "HUSBAND":
      return "WIFE";
    case "WIFE":
      return "HUSBAND";
    // If they are my son or daughter, I am their father or mother — which needs my sex.
    case "SON":
    case "DAUGHTER":
      return otherGender === "MALE" ? "FATHER" : otherGender === "FEMALE" ? "MOTHER" : null;
    // If they are my father or mother, I am their son or daughter — which needs my sex.
    case "FATHER":
    case "MOTHER":
      return otherGender === "MALE" ? "SON" : otherGender === "FEMALE" ? "DAUGHTER" : null;
  }
}
