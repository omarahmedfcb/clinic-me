// Turns the Egyptian drug dataset into catalogue rows, refusing any field a shell or upstream mangled.
// Same signatures as scripts/check-encoding.mjs: U+FFFD, or three or more question marks in a row.

const REPLACEMENT = String.fromCharCode(0xfffd);
const QUESTION_RUN = /\?{3,}/;

/** Fields seen mangled in the source and reviewed by a person; each is written blank, never guessed. */
export const KNOWN_DAMAGED = {
  "SENSORATE MOUTH WASH 120ML": ["scientific_name"],
};

/** Reviewed repairs for this exact source text. "?G" is micrograms (only milli- and micrograms end in G, and an ASCII m would have survived), written MCG as the other 25k rows write it and a doctor types it, keeping the file ASCII. */
export const KNOWN_CORRECTIONS = {
  "MERCFOL TABS": {
    scientific_name: [
      "METHYLCOBALAMINE 1000 ?G+B1+B2+B3+B5+B6+B7+B9 &VIT.C.",
      "METHYLCOBALAMINE 1000 MCG+B1+B2+B3+B5+B6+B7+B9 &VIT.C.",
    ],
  },
  "ORANDOPEN 30 TABLETS": {
    scientific_name: [
      "URIDINE 300 MG+CYTIDINE 100 MG+BENFOTIAMINE 1.1 MG+VITAMIN B12 2.4 ?G",
      "URIDINE 300 MG+CYTIDINE 100 MG+BENFOTIAMINE 1.1 MG+VITAMIN B12 2.4 MCG",
    ],
  },
};

const FIELDS = ["commercial_name_en", "commercial_name_ar", "scientific_name"];

export const isMangled = (value) => value.includes(REPLACEMENT) || QUESTION_RUN.test(value);

const clean = (value) => String(value ?? "").replace(/[|\r\n]+/g, " ").replace(/\s+/g, " ").trim();

export function buildRows(drugs, knownDamaged = KNOWN_DAMAGED, knownCorrections = KNOWN_CORRECTIONS) {
  const seen = new Set();
  const rows = [];
  const blanked = [];
  const corrected = [];
  for (const drug of drugs) {
    const en = clean(drug.commercial_name_en);
    if (en === "" || seen.has(en)) continue;
    seen.add(en);
    const values = FIELDS.map((field) => {
      let value = clean(drug[field]);
      const correction = knownCorrections[en]?.[field];
      if (correction !== undefined) {
        const [from, to] = correction;
        if (value !== from) {
          throw new Error(`Refusing to correct ${JSON.stringify(en)}: ${field} is now ${JSON.stringify(value)}, not the reviewed text.`);
        }
        corrected.push({ drug: en, field });
        value = to;
      }
      if (!isMangled(value)) return value;
      if (!(knownDamaged[en] ?? []).includes(field)) {
        throw new Error(`Refusing to write ${JSON.stringify(en)}: ${field} is mangled (${JSON.stringify(value)}).`);
      }
      blanked.push({ drug: en, field });
      return "";
    });
    rows.push(values.join("|"));
  }
  const survivor = rows.find(isMangled);
  if (survivor !== undefined) throw new Error(`Refusing to write a mangled row: ${JSON.stringify(survivor)}.`);
  for (const [drug, fields] of Object.entries(knownCorrections)) {
    for (const field of Object.keys(fields)) {
      if (!corrected.some((c) => c.drug === drug && c.field === field)) {
        throw new Error(`Refusing to write: the reviewed correction for ${JSON.stringify(drug)} ${field} matched no row.`);
      }
    }
  }
  return { rows, blanked, corrected };
}
