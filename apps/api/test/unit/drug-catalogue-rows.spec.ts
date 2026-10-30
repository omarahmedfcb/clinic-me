// The drug catalogue generator refuses mangled text; a field is blanked or repaired only once a person listed it.
// Runs of "?" and U+FFFD are built at runtime so this file never trips the pre-push encoding check.

import { DRUG_ROWS } from "../../src/modules/clinical/drug-data.ts";

type Touched = { drug: string; field: string };
type BuildRows = (
  drugs: readonly Record<string, unknown>[],
  knownDamaged?: Readonly<Record<string, readonly string[]>>,
  knownCorrections?: Readonly<Record<string, Readonly<Record<string, readonly [string, string]>>>>,
) => { rows: string[]; blanked: Touched[]; corrected: Touched[] };

const lost = (...words: number[]): string => words.map((n) => "?".repeat(n)).join(" ");
const REPLACEMENT = String.fromCharCode(0xfffd);

const drug = (en: string, ar: string, scientific: string) => ({
  commercial_name_en: en,
  commercial_name_ar: ar,
  scientific_name: scientific,
});

const scientificOf = (en: string): string | undefined =>
  DRUG_ROWS.find((row) => row.startsWith(`${en}|`))?.split("|")[2];

describe("the drug catalogue generator", () => {
  let buildRows: BuildRows;
  let isMangled: (value: string) => boolean;

  beforeAll(async () => {
    ({ buildRows, isMangled } = await import("../../scripts/drug-catalogue-rows.mjs"));
  });

  test("writes clean rows as en|ar|scientific, once per English name", () => {
    const { rows, blanked, corrected } = buildRows(
      [
        drug("ADOL 500MG 24 CAPLETS", "أدول 24 كابليتس", "PARACETAMOL(ACETAMINOPHEN)"),
        drug("ADOL 500MG 24 CAPLETS", "مكرر", "DUPLICATE"),
      ],
      {},
      {},
    );
    expect(rows).toEqual(["ADOL 500MG 24 CAPLETS|أدول 24 كابليتس|PARACETAMOL(ACETAMINOPHEN)"]);
    expect(blanked).toEqual([]);
    expect(corrected).toEqual([]);
  });

  test("refuses a field whose Arabic became question marks, naming the drug and the field", () => {
    expect(() => buildRows([drug("SOME DRUG 10 TABS", lost(2, 5, 3), "X")], {}, {})).toThrow(
      /SOME DRUG 10 TABS.*commercial_name_ar is mangled/,
    );
  });

  test("refuses the replacement character", () => {
    expect(() => buildRows([drug("SOME DRUG", `أد${REPLACEMENT}ول`, "X")], {}, {})).toThrow(/mangled/);
  });

  test("blanks a field only when it is listed as reviewed, and reports it", () => {
    const { rows, blanked } = buildRows(
      [drug("SENSORATE MOUTH WASH 120ML", "سينسوراتي موث واش", lost(2, 5, 3, 2, 6, 2, 5, 5))],
      { "SENSORATE MOUTH WASH 120ML": ["scientific_name"] },
      {},
    );
    expect(rows).toEqual(["SENSORATE MOUTH WASH 120ML|سينسوراتي موث واش|"]);
    expect(blanked).toEqual([{ drug: "SENSORATE MOUTH WASH 120ML", field: "scientific_name" }]);
  });

  test("a reviewed blank covers only the field it names", () => {
    expect(() =>
      buildRows([drug("SENSORATE MOUTH WASH 120ML", lost(4), "X")], { "SENSORATE MOUTH WASH 120ML": ["scientific_name"] }, {}),
    ).toThrow(/commercial_name_ar is mangled/);
  });

  describe("reviewed corrections", () => {
    const corrections = { "MERCFOL TABS": { scientific_name: ["B12 1000 ?G", "B12 1000 MCG"] as const } };

    test("replace exactly the reviewed text, and are reported", () => {
      const { rows, corrected } = buildRows([drug("MERCFOL TABS", "ميركفول", "B12 1000 ?G")], {}, corrections);
      expect(rows).toEqual([`MERCFOL TABS|ميركفول|B12 1000 MCG`]);
      expect(corrected).toEqual([{ drug: "MERCFOL TABS", field: "scientific_name" }]);
    });

    test("refuse when the source no longer says what was reviewed", () => {
      expect(() => buildRows([drug("MERCFOL TABS", "ميركفول", "B12 1000 MCG")], {}, corrections)).toThrow(
        /Refusing to correct "MERCFOL TABS"/,
      );
    });

    test("refuse when the drug they name is gone from the source", () => {
      expect(() => buildRows([drug("OTHER", "آخر", "X")], {}, corrections)).toThrow(/matched no row/);
    });
  });

  test("does not catch a lone or doubled question mark", () => {
    expect(isMangled("H?DROXYPROPYL METHYLCELLULOSE")).toBe(false);
    expect(isMangled("A ?? B")).toBe(false);
  });

  test("the committed catalogue carries no mangled row", () => {
    expect(DRUG_ROWS.filter((row) => isMangled(row))).toEqual([]);
    const [, arabic, scientific] = DRUG_ROWS.find((row) => row.startsWith("SENSORATE MOUTH WASH 120ML|"))?.split("|") ?? [];
    expect(arabic?.length ?? 0).toBeGreaterThan(0);
    expect(scientific).toBe("");
  });

  test("the committed catalogue carries both dose units as MCG, and the four letter cases untouched", () => {
    expect(scientificOf("MERCFOL TABS")).toContain("1000 MCG+");
    expect(scientificOf("ORANDOPEN 30 TABLETS")).toMatch(/2\.4 MCG$/);
    expect(DRUG_ROWS.filter((row) => !/^[\x20-\x7e]*$/.test(`${row.split("|")[0]}|${row.split("|")[2]}`))).toEqual([]);
    const letterCases = DRUG_ROWS.filter((row) => /H\?DROXYPROPYL|LE\?N|C\?COPPER|CHOLINE\?/.test(row));
    expect(letterCases).toHaveLength(4);
  });
});
