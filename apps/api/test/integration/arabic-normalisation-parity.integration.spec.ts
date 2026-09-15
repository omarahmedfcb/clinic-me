import { Client } from "pg";
import { FAMILY_NAMES, FEMALE_GIVEN_NAMES, MALE_GIVEN_NAMES } from "../../prisma/seed/arabic-names.ts";
import { normaliseArabicName } from "../../src/modules/patients/domain/normalise-arabic.ts";

/**
 * The nine D19 normalisation rules now exist twice: in Postgres as `normalize_arabic_name()`,
 * feeding the generated column `name_search_ar`, and in TypeScript as `normaliseArabicName()`,
 * used to look a name up in the transliteration dictionary before writing `name_search_latin`.
 *
 * Duplication was not avoidable — the SQL function cannot be called without a database round trip,
 * and the dictionary lookup has to normalise or أحمد and احمد become two different keys — but
 * duplication without a guard is the failure this project keeps finding. So this asserts the two
 * agree character for character, rather than promising that they will.
 *
 * If the rules ever change, one of these two will be edited first, and this test is what says so.
 *
 * The corpus is every seeded name plus the cases each individual rule exists for, including the
 * collisions D19 knowingly accepts. Sampling only "normal" names would let a rule be dropped from
 * one side without either implementation noticing.
 */

const EDGE_CASES = [
  // rule 1: tashkeel
  "مُحَمَّد",
  "عَلِيّ",
  // rule 2: tatweel
  "محـمـد",
  // rule 3: zero-width and bidi marks, as pasted out of WhatsApp
  "محمد​أحمد",
  "‏فاطمة‎",
  // rule 4: Farsi yeh and keheh from a non-Arabic keyboard
  "کریم",
  // rule 5: whitespace
  "  محمد   أحمد  ",
  "محمد\tأحمد",
  // rule 6: alef forms
  "أحمد",
  "احمد",
  "إبراهيم",
  "ابراهيم",
  "آية",
  "ٱحمد",
  // rule 7: hamza carriers
  "عائشة",
  "عايشة",
  "رؤوف",
  "سماء",
  "سما",
  // rule 8: teh marbuta -- including the collision D19 accepts
  "فاطمة",
  "فاطمه",
  "عبده",
  "عبدة",
  // rule 9: alef maksura -- including the collisions D19 accepts
  "مصطفى",
  "مصطفي",
  "على",
  "علي",
  "حسني",
  "حسنى",
  "يسري",
  "يسرى",
  // multi-word, and the empty case
  "عبد الرحمن",
  "محمد أحمد الشناوي",
  "",
  "   ",
];

describe("Arabic normalisation parity: TypeScript and Postgres", () => {
  let client: Client;
  let corpus: string[];

  beforeAll(async () => {
    const url = process.env["DATABASE_URL"];
    if (!url) throw new Error("DATABASE_URL must be set (see setup-env.ts)");
    client = new Client({ connectionString: url });
    await client.connect();

    const seeded = [...MALE_GIVEN_NAMES, ...FEMALE_GIVEN_NAMES, ...FAMILY_NAMES].map((name) => name.ar);
    corpus = [...seeded, ...EDGE_CASES];
  });

  afterAll(async () => {
    await client?.end();
  });

  test("the corpus is large enough that agreement means something", () => {
    // Two implementations that both returned the input unchanged would agree perfectly on a
    // corpus of one plain name.
    expect(corpus.length).toBeGreaterThan(100);
  });

  test("both implementations return the same string for every name in the corpus", async () => {
    const { rows } = await client.query<{ input: string; sql: string }>(
      "SELECT input, normalize_arabic_name(input) AS sql FROM unnest($1::text[]) AS input",
      [corpus],
    );

    const disagreements = rows
      .map((row) => ({ input: row.input, sql: row.sql, ts: normaliseArabicName(row.input) }))
      .filter((row) => row.sql !== row.ts);

    expect(disagreements).toEqual([]);
  });

  test("the rules actually change something, so parity is not agreement on a no-op", async () => {
    // Without this, deleting the body of both implementations would leave every test above green.
    const { rows } = await client.query<{ changed: number }>(
      "SELECT count(*)::int AS changed FROM unnest($1::text[]) AS input WHERE normalize_arabic_name(input) <> input",
      [corpus],
    );
    expect(rows[0]?.changed ?? 0).toBeGreaterThan(15);
    expect(corpus.filter((input) => normaliseArabicName(input) !== input).length).toBeGreaterThan(15);
  });
});
