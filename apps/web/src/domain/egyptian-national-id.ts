// Parses an Egyptian national ID into the facts it encodes. Pure: no I/O, no clock. D27.
// Evidence, never authority — the caller may overwrite anything this returns.

/** `SCHEMA-DECISIONS.md` D27. Governorate codes are the official list; 88 is "born abroad". */
const GOVERNORATES: Readonly<Record<string, string>> = {
  "01": "القاهرة",
  "02": "الإسكندرية",
  "03": "بورسعيد",
  "04": "السويس",
  "11": "دمياط",
  "12": "الدقهلية",
  "13": "الشرقية",
  "14": "القليوبية",
  "15": "كفر الشيخ",
  "16": "الغربية",
  "17": "المنوفية",
  "18": "البحيرة",
  "19": "الإسماعيلية",
  "21": "الجيزة",
  "22": "بني سويف",
  "23": "الفيوم",
  "24": "المنيا",
  "25": "أسيوط",
  "26": "سوهاج",
  "27": "قنا",
  "28": "أسوان",
  "29": "الأقصر",
  "31": "البحر الأحمر",
  "32": "الوادي الجديد",
  "33": "مطروح",
  "34": "شمال سيناء",
  "35": "جنوب سيناء",
  "88": "خارج الجمهورية",
};

export type NationalIdProblem =
  | "LENGTH"
  | "NOT_DIGITS"
  | "CENTURY"
  | "DATE"
  | "GOVERNORATE";

export interface NationalIdFacts {
  dateOfBirth: string;
  gender: "MALE" | "FEMALE";
  governorateCode: string;
  governorate: string;
}

export type NationalIdResult =
  | { ok: true; facts: NationalIdFacts }
  | { ok: false; problem: NationalIdProblem };

/**
 * `C YYMMDD GG SSSS G X` — century, birth date, governorate, serial, gender digit, checksum.
 *
 * The checksum digit is **not** validated. Egypt's algorithm for it is not published, and the
 * several versions circulating disagree; rejecting a real card because of a guessed algorithm is a
 * worse failure at a clinic desk than accepting a mistyped one, which the date and governorate
 * checks already catch most of.
 */
export function parseEgyptianNationalId(input: string): NationalIdResult {
  const digits = input.trim();
  if (digits.length !== 14) return { ok: false, problem: "LENGTH" };
  if (!/^\d{14}$/.test(digits)) return { ok: false, problem: "NOT_DIGITS" };

  const centuryDigit = digits[0]!;
  const century = centuryDigit === "2" ? 1900 : centuryDigit === "3" ? 2000 : null;
  if (century === null) return { ok: false, problem: "CENTURY" };

  const year = century + Number(digits.slice(1, 3));
  const month = Number(digits.slice(3, 5));
  const day = Number(digits.slice(5, 7));

  // Constructed in UTC and read back, so 31 February fails rather than rolling into March.
  const date = new Date(Date.UTC(year, month - 1, day));
  const real =
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day;
  if (!real) return { ok: false, problem: "DATE" };

  const governorateCode = digits.slice(7, 9);
  const governorate = GOVERNORATES[governorateCode];
  if (governorate === undefined) return { ok: false, problem: "GOVERNORATE" };

  // The thirteenth digit: odd is male, even is female.
  const gender = Number(digits[12]) % 2 === 1 ? "MALE" : "FEMALE";

  return {
    ok: true,
    facts: {
      dateOfBirth: `${String(year).padStart(4, "0")}-${digits.slice(3, 5)}-${digits.slice(5, 7)}`,
      gender,
      governorateCode,
      governorate,
    },
  };
}

/** Whether facts a user typed disagree with the ID. A warning, never a refusal (D27). */
export function nationalIdDisagreements(
  facts: NationalIdFacts,
  entered: { dateOfBirth?: string | null; gender?: string | null },
): ("dateOfBirth" | "gender")[] {
  const out: ("dateOfBirth" | "gender")[] = [];
  if (entered.dateOfBirth != null && entered.dateOfBirth.slice(0, 10) !== facts.dateOfBirth) {
    out.push("dateOfBirth");
  }
  if (entered.gender != null && entered.gender !== facts.gender) out.push("gender");
  return out;
}
