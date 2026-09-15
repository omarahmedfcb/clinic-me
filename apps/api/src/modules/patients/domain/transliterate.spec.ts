import {
  FAMILY_NAMES,
  FEMALE_GIVEN_NAMES,
  MALE_GIVEN_NAMES,
} from "../../../../prisma/seed/arabic-names.ts";
import { normaliseArabicName } from "./normalise-arabic.ts";
import { DICTIONARY_SIZE, latinKeyCoverage, latinSearchKey, transliterateArabicName } from "./transliterate.ts";

/**
 * The dictionary is the load-bearing part of Latin search: there is no letter-level fallback
 * behind it, so a name it does not know has no Latin key at all. These are the guards on that.
 *
 * Both of the first two were verified by breaking them before being trusted — removing محمد from
 * the table fails the coverage test by name, and adding a consonant-skeleton fallback fails the
 * null test.
 */

const SEEDED_COMPONENTS = [...MALE_GIVEN_NAMES, ...FEMALE_GIVEN_NAMES, ...FAMILY_NAMES];

describe("transliterateArabicName", () => {
  test("every seeded Arabic name component resolves to at least one Latin spelling", () => {
    // The seed is the only corpus of Arabic names this project has. If the dictionary cannot cover
    // that, it certainly cannot cover a real clinic, and every Latin search in the demo data would
    // quietly return nothing.
    const unresolved = SEEDED_COMPONENTS.filter((name) => transliterateArabicName(name.ar) === null);
    expect(unresolved.map((name) => name.ar)).toEqual([]);
  });

  test("a name absent from the dictionary yields null, not a consonant skeleton", () => {
    // مصعب, ظافر, غنيمة are real Egyptian names deliberately left out of the table. A letter-level
    // fallback would store "msab", "zafr", "ghnyma" -- unfindable by anything a human would type,
    // and indistinguishable from a row the dictionary handled well.
    for (const absent of ["مصعب", "ظافر", "غنيمة", "قدري"]) {
      expect({ absent, key: transliterateArabicName(absent) }).toEqual({ absent, key: null });
    }
  });

  test("an empty or whitespace-only name yields null rather than an empty string", () => {
    // An empty string in the column would be neither a key nor an honest absence, and would not be
    // counted by `WHERE name_search_latin IS NULL`.
    for (const blank of ["", "   ", "\t\n"]) expect(transliterateArabicName(blank)).toBeNull();
  });

  describe("what the key contains", () => {
    test("holds every plausible spelling, not one canonical form", () => {
      // Measured: storing one spelling finds 63/81 real alternatives at the 0.3 trigram threshold;
      // storing all finds 81/81, with no rise in false matches. See D19.
      expect(transliterateArabicName("محمد")).toBe("Mohamed Mohammed Muhammad");
    });

    test("leads with the Egyptian spelling, not the scholarly transliteration", () => {
      // MSA `u` is Egyptian `o`, and the article is El, not Al. A rule-based transliterator that
      // got the vowels right would still produce Muhammad, Mustafa, Huda, Al Qadi.
      expect(transliterateArabicName("مصطفى")?.split(" ")[0]).toBe("Mostafa");
      expect(transliterateArabicName("هدى")?.split(" ")[0]).toBe("Hoda");
      expect(transliterateArabicName("جرجس")?.split(" ")[0]).toBe("Guirguis");
    });

    test("joins the components of a full name", () => {
      expect(transliterateArabicName("محمد أحمد الشناوي")).toBe(
        "Mohamed Mohammed Muhammad Ahmed Ahmad El Shennawy Shennawy",
      );
    });

    test("matches a multi-word family name whole, not by its first word", () => {
      // Short-first matching would consume عبد alone, leave الرحمن unmatched, and halve the key.
      expect(transliterateArabicName("عبد الرحمن")).toBe("Abdelrahman Abdel Rahman Abdulrahman");
    });

    test("does not repeat a spelling two components share", () => {
      // حسن appears as both a given and a family name; the key should not carry "Hassan" twice.
      expect(transliterateArabicName("حسن حسن")).toBe("Hassan Hasan");
    });

    test("finds a name written without its hamza, as staff routinely type it", () => {
      // احمد and أحمد are the same name. Without the D19 normalisation the second would miss.
      expect(transliterateArabicName("احمد")).toBe(transliterateArabicName("أحمد"));
      expect(transliterateArabicName("عايشة")).toBe(transliterateArabicName("عائشة"));
    });
  });

  describe("partial coverage", () => {
    test("a rare middle name does not cost the names on either side of it", () => {
      // Dropping the whole name to null because one component is rare would throw away a working
      // search key and cause the duplicate record D19 exists to prevent.
      const key = transliterateArabicName("محمد مصعب الشناوي");
      expect(key).toContain("Mohamed");
      expect(key).toContain("El Shennawy");
    });

    test("coverage is reported as full, partial or none", () => {
      // `name_search_latin IS NULL` only ever finds "none". Partial coverage is a real gap that
      // still produces a usable key, so counting it needs this.
      expect(latinKeyCoverage("محمد أحمد الشناوي")).toBe("full");
      expect(latinKeyCoverage("محمد مصعب الشناوي")).toBe("partial");
      expect(latinKeyCoverage("مصعب ظافر")).toBe("none");
    });
  });

  test("the dictionary keys are stored normalised, so lookup cannot depend on how they were typed", () => {
    // Guards the module-load normalisation. Written with hamzas for readability; if that step were
    // dropped, أحمد would be a key that normalised input could never match.
    expect(DICTIONARY_SIZE).toBeGreaterThan(100);
    for (const name of SEEDED_COMPONENTS) {
      expect(transliterateArabicName(normaliseArabicName(name.ar))).not.toBeNull();
    }
  });
});

describe("latinSearchKey", () => {
  test("combines the transliteration with the recorded English name", () => {
    // The two disagree constantly -- Mohamed is what a human typed, Muhammad is a spelling the
    // dictionary carries -- and D19 puts both in the one column so either finds the patient.
    const key = latinSearchKey("محمد أحمد الشناوي", "Mohamed Ahmed El Shennawy");
    expect(key).toContain("muhammad");
    expect(key).toContain("shennawy");
  });

  test("is entirely lower-cased, because similarity() is case-sensitive", () => {
    expect(latinSearchKey("محمد", "Mohamed")).toBe(latinSearchKey("محمد", "MOHAMED"));
    expect(latinSearchKey("محمد", null)).toBe("mohamed mohammed muhammad");
  });

  test("does not repeat a spelling both halves supply", () => {
    expect(latinSearchKey("محمد", "Mohamed")?.match(/mohamed/g)).toHaveLength(1);
  });

  test("an English name is the only key for a patient the dictionary cannot read", () => {
    // مصعب is absent from the table. Without full_name_en this row has no Latin key at all; with
    // it, the passport spelling is still a route in.
    expect(latinSearchKey("مصعب", null)).toBeNull();
    expect(latinSearchKey("مصعب", "Mosaab")).toBe("mosaab");
  });

  test("strips accents, so an accented entry and a plain one are one key", () => {
    expect(latinSearchKey("مصعب", "José")).toBe("jose");
  });

  test("null when neither source yields anything, keeping the NULL count honest", () => {
    expect(latinSearchKey("مصعب", null)).toBeNull();
    expect(latinSearchKey("", "   ")).toBeNull();
  });
});
