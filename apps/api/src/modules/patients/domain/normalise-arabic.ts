/**
 * The TypeScript twin of `normalize_arabic_name()` in
 * `prisma/sql/10-patient-bilingual-names.sql` — the nine rules of SCHEMA-DECISIONS.md D19.
 *
 * ## Why this is duplicated at all
 *
 * Postgres owns `name_search_ar` and computes it in a `GENERATED ALWAYS ... STORED` column, so
 * nothing here can drift from it *for that column*. But `name_search_latin` is
 * application-maintained (D19 splits the two by volatility), and looking a name up in the
 * transliteration dictionary needs the same normalisation first: without it أحمد and احمد are two
 * different keys and the second one misses.
 *
 * Reimplementing rules that already exist in SQL is a drift risk, and the honest answer is not to
 * promise it will not drift but to make drift fail the build.
 * `test/integration/arabic-normalisation-parity.integration.spec.ts` runs both implementations over
 * every seeded name and a corpus of edge cases and asserts they agree character for character. If
 * you change one, that test tells you about the other.
 *
 * ## No I/O
 *
 * `modules/patients/domain/` follows the same rule as `modules/appointments/domain/` (CLAUDE.md):
 * zero I/O. These are pure string functions, which is what lets the unit tests exercise them
 * without a database — and what stops a unit spec acquiring a dependency on `APP_DATABASE_URL`.
 */

/**
 * Characters deleted outright: they carry no identity.
 *
 * Written as escapes rather than literals for the same reason the SQL does it — a combining mark
 * pasted into source is invisible on screen and unreviewable in a diff. You cannot tell a fatha
 * from a damma from nothing at all.
 */
const DELETED = new Set([
  // tashkeel and Quranic marks U+064B..U+065F, and the superscript alef U+0670
  ...Array.from({ length: 0x065f - 0x064b + 1 }, (_unused, offset) => String.fromCodePoint(0x064b + offset)),
  "ٰ",
  "ـ", // tatweel / kashida, decorative elongation
  "ء", // standalone hamza
  // zero-width space / non-joiner / joiner, LRM, RLM, Arabic letter mark. These arrive invisibly
  // in names pasted out of WhatsApp and would otherwise defeat exact matching.
  "​",
  "‌",
  "‍",
  "‎",
  "‏",
  "؜",
]);

/** One-to-one replacements, in the same order as the SQL `translate()` pair. */
const MAPPED = new Map([
  ["أ", "ا"], // أ -> ا
  ["إ", "ا"], // إ -> ا
  ["آ", "ا"], // آ -> ا
  ["ٱ", "ا"], // ٱ -> ا
  ["ة", "ه"], // ة -> ه   teh marbuta to heh
  ["ى", "ي"], // ى -> ي   alef maksura to yeh
  ["ؤ", "و"], // ؤ -> و
  ["ئ", "ي"], // ئ -> ي
  ["ی", "ي"], // Farsi yeh -> yeh
  ["ک", "ك"], // Farsi keheh -> kaf
]);

/**
 * Normalises an Arabic name for search. Character-for-character identical to the SQL function.
 *
 * Rules 8 and 9 (ة → ه, ى → ي) knowingly collapse genuinely different names — عبده/عبدة,
 * حسني/حسنى, يسري/يسرى. That is accepted only because the result is a retrieval key that carries
 * no UNIQUE constraint, never drives an automatic merge, and is never displayed. See D19; both
 * constraints are load-bearing, not incidental.
 */
export function normaliseArabicName(input: string): string {
  let out = "";
  for (const character of input) {
    if (DELETED.has(character)) continue;
    out += MAPPED.get(character) ?? character;
  }
  return out.replace(/\s+/gu, " ").trim();
}
