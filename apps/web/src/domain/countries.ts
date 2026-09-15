// ISO 3166-1 alpha-2 codes, named by Intl rather than a hand-typed table. D26 requires nationality.
// A typed table of 249 Arabic names is 249 chances to be wrong, and the runtime already has them.

/** Every assignable alpha-2 code, as one string so the file stays a lookup and not a document. */
const CODES =
  "AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS " +
  "BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE " +
  "EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM " +
  "HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC " +
  "LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA " +
  "NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW " +
  "SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO " +
  "TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW";

export const DEFAULT_NATIONALITY = "EG";

/**
 * Nationalities most Egyptian clinics see, pinned to the top of the list.
 *
 * Not a judgement about people — a judgement about typing. A receptionist registering a Sudanese or
 * Syrian patient should not scroll past 180 countries to reach one of the five they enter weekly.
 */
const COMMON = ["EG", "SD", "SY", "PS", "YE", "LY", "SA", "IQ", "JO", "LB"];

export interface Country {
  code: string;
  name: string;
}

function namer(locale: string): (code: string) => string {
  try {
    const display = new Intl.DisplayNames([locale], { type: "region" });
    return (code) => display.of(code) ?? code;
  } catch {
    // Falls back to the bare code rather than a blank: an unnamed country is still selectable, and
    // a blank row would look like a broken list.
    return (code) => code;
  }
}

/** The full list, common nationalities first, the rest sorted in the given locale. */
export function countries(locale: string = "ar"): Country[] {
  const name = namer(locale);
  const all = CODES.split(" ").map((code) => ({ code, name: name(code) }));
  const collator = new Intl.Collator(locale);

  const common = COMMON.map((code) => all.find((c) => c.code === code)).filter(
    (c): c is Country => c !== undefined,
  );
  const rest = all
    .filter((c) => !COMMON.includes(c.code))
    .sort((a, b) => collator.compare(a.name, b.name));

  return [...common, ...rest];
}

export function countryName(code: string | null, locale: string = "ar"): string | null {
  if (code === null || code === "") return null;
  return namer(locale)(code);
}
