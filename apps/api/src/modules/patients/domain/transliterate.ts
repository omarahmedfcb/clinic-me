import { normaliseArabicName } from "./normalise-arabic.ts";

/**
 * Latin search keys for Arabic names — the volatile half of SCHEMA-DECISIONS.md D19, kept out of
 * the `GENERATED` column precisely because we expect to keep improving it.
 *
 * ## This is a dictionary, not a transliterator, and that is not a shortcut
 *
 * A letter-by-letter mapping cannot work here, and it fails in a way that looks like it works.
 * Arabic script omits short vowels, so a faithful character mapping returns consonant skeletons:
 *
 *     محمد  -> mhmd        محمود -> mhmwd       شريف -> shryf
 *     طارق  -> tark        مصطفى -> mstfa       ياسر -> yasr
 *
 * Nobody types any of those. The vowels are not in the source to map; they have to be known per
 * name. So the table below is a word-level dictionary, and there is deliberately **no letter-level
 * fallback** — see `transliterateArabicName` for why storing a skeleton would be worse than
 * storing nothing.
 *
 * ## Each name holds every spelling Egyptians actually use, not one canonical form
 *
 * Measured against `pg_trgm` at the 0.3 threshold the search uses, over 81 cases where a
 * receptionist types a real spelling other than the stored one:
 *
 *     stored one spelling    63/81 found (78%)    14 false matches across 4,005 name pairs
 *     stored all spellings   81/81 found (100%)   13 false matches
 *
 * Recall goes to 100% and the false-match count does not rise, so this is not a trade-off. The
 * misses a single spelling produces are not exotic — `Mohamed` vs `Muhammad` scores 0.13, `Nevine`
 * vs `Niveen` 0.08, `El Kady` vs `El Qadi` 0.23 — and by D19's own reasoning a miss is what makes
 * a receptionist create a second record.
 *
 * The spellings are ordered most-common-in-Egypt first, and the first one is the Egyptian
 * convention rather than the scholarly transliteration: محمد is `Mohamed` before `Muhammad`, مصطفى
 * is `Mostafa` before `Mustafa`, جرجس is `Guirguis` before `Girgis`. MSA `u` is Egyptian `o`, and
 * the definite article is `El`, not `Al`.
 *
 * ## Keys are normalised on load
 *
 * Written with their hamzas so they are readable, then normalised through the D19 rules at module
 * load, so أحمد and احمد resolve to the same entry. Writing pre-normalised keys would make the
 * table unreadable and would silently rot if the rules ever changed.
 */
const SPELLINGS: Readonly<Record<string, readonly string[]>> = {
  // ── male given names ───────────────────────────────────────────────────────────────────────
  محمد: ["Mohamed", "Mohammed", "Muhammad"],
  أحمد: ["Ahmed", "Ahmad"],
  محمود: ["Mahmoud", "Mahmood"],
  مصطفى: ["Mostafa", "Moustafa", "Mustafa"],
  خالد: ["Khaled", "Khalid"],
  عمرو: ["Amr"],
  هشام: ["Hisham", "Hesham"],
  طارق: ["Tarek", "Tarik"],
  شريف: ["Sherif", "Sharif"],
  ياسر: ["Yasser", "Yaser"],
  وليد: ["Walid", "Waleed"],
  سامح: ["Sameh"],
  هاني: ["Hany", "Hani"],
  إيهاب: ["Ihab", "Ehab"],
  تامر: ["Tamer"],
  كريم: ["Karim", "Kareem"],
  عصام: ["Essam", "Isam"],
  رامي: ["Ramy", "Rami"],
  أيمن: ["Ayman"],
  حسام: ["Hossam", "Hussam"],
  مينا: ["Mina", "Meena"],
  بيشوي: ["Bishoy", "Beshoy"],
  جرجس: ["Guirguis", "Girgis"],
  عماد: ["Emad", "Imad"],
  صلاح: ["Salah"],
  فتحي: ["Fathy", "Fathi"],
  رفعت: ["Refaat", "Rifaat"],
  نبيل: ["Nabil", "Nabeel"],
  سيد: ["Sayed", "Sayyed"],
  جمال: ["Gamal", "Jamal"],
  علي: ["Ali", "Aly"],
  حسن: ["Hassan", "Hasan"],
  حسين: ["Hussein", "Hossein"],
  عمر: ["Omar", "Umar"],
  يوسف: ["Youssef", "Yousef", "Yusuf"],
  إسلام: ["Islam"],
  مازن: ["Mazen"],
  شادي: ["Shady", "Shadi"],
  زياد: ["Ziad", "Zeyad"],
  أنور: ["Anwar"],
  ماهر: ["Maher"],
  سمير: ["Samir", "Sameer"],
  منير: ["Mounir", "Munir"],
  فاروق: ["Farouk", "Faruk"],
  عادل: ["Adel", "Adil"],
  رضا: ["Reda", "Rida"],
  مجدي: ["Magdy", "Magdi"],
  وائل: ["Wael", "Wail"],
  بسام: ["Bassam"],
  عاطف: ["Atef", "Atif"],

  // ── female given names ─────────────────────────────────────────────────────────────────────
  فاطمة: ["Fatma", "Fatima"],
  عائشة: ["Aisha", "Aysha"],
  مريم: ["Mariam", "Maryam"],
  نورا: ["Nora", "Noura"],
  هبة: ["Heba", "Hiba"],
  دينا: ["Dina", "Deena"],
  رانيا: ["Rania"],
  منى: ["Mona", "Mouna"],
  سلمى: ["Salma"],
  ياسمين: ["Yasmin", "Yasmine", "Jasmine"],
  هدى: ["Hoda", "Huda"],
  أميرة: ["Amira", "Ameera"],
  شيماء: ["Shaimaa", "Shaymaa"],
  نهى: ["Noha", "Nuha"],
  إيمان: ["Eman", "Iman"],
  سارة: ["Sara", "Sarah"],
  مي: ["May", "Mai"],
  ولاء: ["Walaa"],
  غادة: ["Ghada"],
  إنجي: ["Engy", "Engi"],
  مادلين: ["Madeleine", "Madlen"],
  مارينا: ["Marina"],
  نيفين: ["Nevine", "Niveen"],
  سماح: ["Samah"],
  عبير: ["Abeer", "Abir"],
  أسماء: ["Asmaa", "Asma"],
  زينب: ["Zeinab", "Zainab"],
  خديجة: ["Khadija", "Khadiga"],
  رحمة: ["Rahma"],
  آية: ["Aya", "Aia"],
  نرمين: ["Nermeen", "Nermin"],
  بسمة: ["Basma"],
  رقية: ["Roqaya", "Ruqaya"],
  ثريا: ["Soraya", "Thoraya"],
  نادية: ["Nadia"],
  سميرة: ["Samira", "Sameera"],
  ليلى: ["Laila", "Leila"],
  جيهان: ["Gihan", "Jehan"],
  شيرين: ["Sherine", "Shireen"],
  مها: ["Maha"],
  رشا: ["Rasha"],
  نجلاء: ["Naglaa"],
  هناء: ["Hanaa"],
  سعاد: ["Souad", "Soad"],

  // ── family names ───────────────────────────────────────────────────────────────────────────
  "عبد الرحمن": ["Abdelrahman", "Abdel Rahman", "Abdulrahman"],
  السيد: ["El Sayed", "Elsayed", "Al Sayed"],
  إبراهيم: ["Ibrahim", "Ebrahim"],
  "عبد العزيز": ["Abdelaziz", "Abdel Aziz"],
  الشناوي: ["El Shennawy", "Shennawy"],
  فهمي: ["Fahmy", "Fahmi"],
  زكي: ["Zaki", "Zaky"],
  رشدي: ["Roshdy", "Rushdi"],
  الديب: ["El Deeb", "Eldeeb"],
  "عبد الله": ["Abdallah", "Abdullah"],
  سليمان: ["Soliman", "Suleiman"],
  مرسي: ["Morsy", "Morsi"],
  الغباشي: ["El Ghobashy", "Ghobashy"],
  شعبان: ["Shaaban"],
  القاضي: ["El Kady", "El Qadi"],
  بدوي: ["Badawy", "Badawi"],
  الحديدي: ["El Hadidy", "Hadidi"],
  عوض: ["Awad"],
  صبري: ["Sabry", "Sabri"],
  الشربيني: ["El Sherbiny", "Sherbini"],
  المصري: ["El Masry", "Elmasri"],
  "عبد الحميد": ["Abdelhamid", "Abdel Hamid"],
  خليل: ["Khalil", "Khaleel"],
  منصور: ["Mansour", "Mansur"],
  الجندي: ["El Gindy", "El Gendy"],
  طنطاوي: ["Tantawy", "Tantawi"],
  الأنصاري: ["El Ansary", "Ansari"],
  حمدي: ["Hamdy", "Hamdi"],
  شاهين: ["Shaheen", "Shahin"],
  "عبد الفتاح": ["Abdelfattah", "Abdel Fattah"],
  "عبد الناصر": ["Abdelnasser", "Abdel Nasser"],
  الشافعي: ["El Shafei", "Shafei"],
  عثمان: ["Osman", "Othman"],
  رمضان: ["Ramadan"],
  الطيب: ["El Tayeb", "Tayeb"],
};

/** Normalised Arabic component -> its Latin spellings. Built once, at module load. */
const DICTIONARY: ReadonlyMap<string, readonly string[]> = new Map(
  Object.entries(SPELLINGS).map(([arabic, spellings]) => [normaliseArabicName(arabic), spellings]),
);

/**
 * Dictionary keys longest first. A full name is matched greedily against these, so the two-word
 * "عبد الرحمن" wins over any shorter key sharing its prefix. Matching short-first would consume
 * "عبد" alone, leave "الرحمن" unmatched, and quietly halve the key.
 */
const KEYS_LONGEST_FIRST: readonly string[] = [...DICTIONARY.keys()].sort((a, b) => b.length - a.length);

/**
 * The Latin search key for an Arabic name, or `null` when the dictionary recognises nothing in it.
 *
 * **`null`, never a consonant skeleton.** A letter-level fallback would put `nrmyn` in the column
 * for نرمين — unfindable by any Latin input a human would type, and indistinguishable from a row
 * the dictionary handled well. That is a guarantee that looks total and is not, which is the exact
 * failure this codebase keeps finding. A `null` is an honest "no Latin key": `full_name_en` and the
 * phone number remain the routes in, and
 *
 *     SELECT count(*) FROM patients WHERE name_search_latin IS NULL
 *
 * becomes a real measurement of how much of the patient population the dictionary misses. A rising
 * proportion means the table above needs extending. A skeleton would make that unknowable.
 *
 * **Partially recognised names keep the parts we know.** For محمد أحمد نرمين the key is
 * "Mohamed Mohammed Muhammad Ahmed Ahmad" and the unknown component contributes nothing. Dropping
 * the whole name to `null` because one component is rare would throw away a working search key and
 * cause the duplicate record that D19 exists to prevent — and a duplicate splits a medical history
 * permanently. Note the consequence for the metric above: it counts names where **nothing** was
 * recognised, so partial coverage is invisible to it. `latinKeyCoverage()` reports both.
 */
export function transliterateArabicName(fullName: string): string | null {
  const spellings = recognisedComponents(fullName).flatMap((component) => component.spellings);
  if (spellings.length === 0) return null;
  return [...new Set(spellings)].join(" ");
}

interface RecognisedComponent {
  arabic: string;
  spellings: readonly string[];
}

function recognisedComponents(fullName: string): RecognisedComponent[] {
  let rest = normaliseArabicName(fullName);
  const found: RecognisedComponent[] = [];

  while (rest.length > 0) {
    const key = KEYS_LONGEST_FIRST.find((candidate) => rest === candidate || rest.startsWith(`${candidate} `));
    if (key === undefined) {
      // Skip one word and keep going: a rare middle name must not hide the given and family names
      // on either side of it.
      const space = rest.indexOf(" ");
      if (space === -1) break;
      rest = rest.slice(space + 1);
      continue;
    }
    found.push({ arabic: key, spellings: DICTIONARY.get(key) ?? [] });
    rest = rest.slice(key.length).trimStart();
  }

  return found;
}

/**
 * How well the dictionary covers one name: `"full"`, `"partial"`, or `"none"`.
 *
 * Exists so the gap can be reported honestly. `name_search_latin IS NULL` only finds `"none"`;
 * a name where two components in three resolved is a real gap that produces a usable key anyway,
 * and counting it needs this. Intended for the admin view D19 calls for.
 */
export function latinKeyCoverage(fullName: string): "full" | "partial" | "none" {
  const normalised = normaliseArabicName(fullName);
  if (normalised.length === 0) return "none";
  const recognised = recognisedComponents(normalised);
  if (recognised.length === 0) return "none";

  const recognisedWordCount = recognised.reduce((total, part) => total + part.arabic.split(" ").length, 0);
  return recognisedWordCount === normalised.split(" ").length ? "full" : "partial";
}

/** The number of Arabic name components the dictionary knows. For tests and for the admin view. */
export const DICTIONARY_SIZE = DICTIONARY.size;

/**
 * The value of `patients.name_search_latin`: the transliteration of the Arabic name **plus** the
 * English name a human recorded, if there is one. D19 specifies both sources in the one column.
 *
 * They are combined rather than chosen between because they answer different halves of the same
 * question and disagree constantly. `full_name_en` is what somebody copied off a passport —
 * authoritative for that patient, and the only Latin key at all for a name the dictionary does not
 * know. The transliteration covers the ~80% of patients who have no English name recorded, and
 * carries the spelling variants a receptionist might type instead. Storing only one of the two
 * would lose whichever half the person searching happened to use.
 *
 * The whole key is lower-cased. `similarity()` is case-sensitive, so a column mixing the
 * dictionary's "Mohamed" with a typed "mohamed" would score the two differently for no reason a
 * user could see. Case carries no information in a search key.
 *
 * `null` when neither source yields anything, which keeps
 * `WHERE name_search_latin IS NULL` an honest measurement of the gap.
 */
export function latinSearchKey(fullNameAr: string, fullNameEn: string | null): string | null {
  const parts = [transliterateArabicName(fullNameAr), normaliseLatin(fullNameEn)].filter(
    (part): part is string => part !== null && part.length > 0,
  );
  if (parts.length === 0) return null;
  return [...new Set(parts.join(" ").toLowerCase().split(" "))].join(" ");
}

/**
 * Lower-cases and strips accents from a recorded English name, so "José" and "Jose" are one key.
 * Trigram similarity is case-sensitive, and `full_name_en` is free text a human typed.
 */
function normaliseLatin(value: string | null): string | null {
  if (value === null) return null;
  const normalised = value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/\s+/gu, " ")
    .trim();
  return normalised.length === 0 ? null : normalised;
}
