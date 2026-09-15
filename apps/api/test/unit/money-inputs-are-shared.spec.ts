import { readFileSync } from "node:fs";
import path from "node:path";
import { sourceFiles, stripComments } from "../../scripts/route-capabilities.ts";

/**
 * **Every money field in the product goes through `MoneyInput`, and no amount is signed by hand.**
 *
 * Two defects from the founder's review of #99, both invisible to every other check:
 *
 * 1. **The scale.** A box whose value was sent straight through as minor units takes `50` and means
 *    fifty piastres. Nothing fails: the request succeeds, the row is written, and the invoice is
 *    wrong by two orders of magnitude. The ruling is that money is entered and shown in major units
 *    everywhere and converted only on the wire, which is what `MoneyInput` does in one place.
 *
 * 2. **The sign.** `Intl` formats a negative amount as `<RLM><LRM>-200.00 ج.م.<RLM>` — the LRM is
 *    there so the minus stays inside the number's own left-to-right run. A `−` concatenated in
 *    front instead produces `−<RLM>50.00 ج.م.<RLM>`, where the sign sits outside that run and, in
 *    an Arabic paragraph, renders detached from the figure it belongs to. The discount then reads
 *    as though it were not a deduction at all.
 */

const WEB_SRC = path.resolve(__dirname, "..", "..", "..", "web", "src");

/** A translation key that names an amount of money rather than a count, a rate or a sentence. */
const MONEY_KEY = /(amount|price|discount|share|fee|cost|balance|total)/i;
/** Keys that merely contain a money word: a reason, a hint, a percentage, a heading. */
const NOT_A_MONEY_FIELD = /(reason|hint|title|mode|percent|preview|explain|label)/i;

function webFiles(): { name: string; source: string }[] {
  return sourceFiles(WEB_SRC, [".ts", ".tsx"])
    .filter((file) => !file.endsWith(".spec.ts") && !file.endsWith(".spec.tsx"))
    .map((file) => ({
      name: path.relative(WEB_SRC, file).split(path.sep).join("/"),
      source: stripComments(readFileSync(file, "utf8")),
    }));
}

describe("every money field is the shared one", () => {
  const files = webFiles();

  test("the sweep can see the files it is sweeping, so an empty pass is impossible", () => {
    expect(files.length).toBeGreaterThan(40);
    expect(files.some((file) => file.name === "design-system/MoneyInput.tsx")).toBe(true);
  });

  test("no screen builds its own money box out of a plain TextInput", () => {
    const offenders: string[] = [];
    for (const { name, source } of files) {
      // `MoneyInput` is the one place a `TextInput` is allowed to hold an amount: it is the wrapper.
      if (name === "design-system/MoneyInput.tsx") continue;
      for (const block of source.matchAll(/<TextInput\b[\s\S]*?\/>/g)) {
        const label = /label=\{t\("([^"]+)"\)\}/.exec(block[0])?.[1];
        if (label === undefined) continue;
        if (!MONEY_KEY.test(label) || NOT_A_MONEY_FIELD.test(label)) continue;
        offenders.push(`${name} -> ${label}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("no amount is sent as minor units straight from an input", () => {
    // `Number(someText)` assigned into a `*Minor` field is the exact shape the desk had: the box
    // held "50" and the wire carried 50 minor units. `MoneyInput` returns minor units already, so
    // a screen using it never needs the conversion and never writes this.
    const offenders: string[] = [];
    for (const { name, source } of files) {
      if (name === "design-system/MoneyInput.tsx" || name === "i18n/format.ts") continue;
      for (const hit of source.matchAll(/(\w*[Mm]inor)\s*[:=]\s*Number\(/g)) {
        offenders.push(`${name} -> ${hit[1] as string}: Number(...)`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("no amount is signed by concatenation", () => {
    // Ban the character rather than the pattern: every legitimate negative amount comes out of
    // `formatMinor(-x)` already signed, so a minus sign in JSX around an amount has no honest use.
    const offenders: string[] = [];
    for (const { name, source } of files) {
      if (name === "i18n/format.ts") continue;
      for (const hit of source.matchAll(/[−-]\s*\$\{\s*(?:money|formatMinor|printedAmount)\b/g)) {
        offenders.push(`${name} -> ${hit[0] as string}`);
      }
      for (const hit of source.matchAll(/\{\s*(?:money|formatMinor|printedAmount)\b/g)) {
        const before = source.slice(Math.max(0, (hit.index ?? 0) - 12), hit.index ?? 0);
        if (/[−-]\s*$/.test(before)) offenders.push(`${name} -> ${before.trim()}{money(...)`);
      }
      if (/\?\s*"\+"\s*:\s*"−"/.test(source)) offenders.push(`${name} -> ? "+" : "−"`);
    }
    expect(offenders).toEqual([]);
  });
});
