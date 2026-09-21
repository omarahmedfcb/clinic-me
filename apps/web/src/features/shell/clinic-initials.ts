// Initials for a clinic, when it has uploaded no logo. Pure, so the rule can be shown what it does.

/**
 * **The first two words, not the first and the last** — which is the opposite of `initialsOf`, and
 * the difference is the shape of the names rather than a preference.
 *
 * A person's distinctive parts sit at the ends: a given name and a family name, with whatever is in
 * between belonging to neither. A clinic's sit at the front: «عيادة **النيل** لطب الأسرة»,
 * «مركز **الشفاء** للجلدية والتجميل». The tail of a clinic name is a description of what it does,
 * and it is the part clinics share.
 *
 * What the two rules actually produce, on the names this product has seen:
 *
 * | name | first + last | first two |
 * |---|---|---|
 * | عيادة النيل لطب الأسرة | عأ | **عن** |
 * | مركز الشفاء للجلدية والتجميل | مو | **مش** |
 * | عيادة الشفاء التخصصية | عت | **عش** |
 * | Nile Family Clinic | NC | **NF** |
 *
 * Reusing `initialsOf` would have given the first two clinics `عأ` and `مو` — the distinctive word
 * dropped in both, and the second letter taken from «الأسرة» and «والتجميل», which are descriptions.
 *
 * **What this rule gets wrong, stated rather than discovered:** every clinic whose name begins
 * «عيادة» shares its first letter, so two of them differ only in the second. That is acceptable for
 * a fallback mark beside the name it abbreviates — it is not an identifier — and the alternative
 * was a list of generic leading words, which is the kind of matching rule this project has already
 * decided needs its false positives shown before it is trusted.
 */
export function clinicInitials(name: string): string {
  const words = name
    .trim()
    .split(/\s+/)
    .filter((word) => word !== "");

  // «ال» is dropped from each word taken, for the reason `initialsOf` drops it from a family name:
  // it is an article, and a clinic called «عيادة النيل» would otherwise read عا.
  const letterOf = (word: string): string => {
    const bare = word.startsWith("ال") && word.length > 2 ? word.slice(2) : word;
    return bare.charAt(0);
  };

  return words.slice(0, 2).map(letterOf).join("");
}
