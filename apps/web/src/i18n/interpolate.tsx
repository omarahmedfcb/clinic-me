import type { ReactNode } from "react";

/**
 * Fill `{placeholders}` in a translated string, wrapping each value in `<bdi>`.
 *
 * ## The bug this exists to fix, because `.replace()` looks fine and is not
 *
 * A patient's name is Arabic even when the interface is English — `SCHEMA-DECISIONS.md` D19 makes
 * Arabic the name of record and English optional, so a mixed-direction sentence is the normal case,
 * not an edge one. Building that sentence with `String.replace()` produces correct *characters* in
 * the wrong *visual order*, because the browser applies the Unicode bidirectional algorithm to the
 * finished string and cannot tell which runs are names.
 *
 * Observed on the transfer banner, 2026-09-01: the template
 * `"{doctor} rejected the transfer of {patient}: {reason}"` rendered as
 * *"خالد رفعت عوض rejected the transfer of أخصائي دينا كريم القاضي"* — the patient and the doctor
 * appear to have swapped places. Nothing was swapped. Each Arabic run is laid out right-to-left and
 * the runs sit either side of the English verb, so the eye reads them in the opposite order to the
 * one the sentence means. **A reader cannot tell that from a rendered screen; they conclude the
 * code passed the arguments the wrong way round** — which is exactly what happened here.
 *
 * `<bdi>` (bidirectional isolate) is the fix HTML provides for precisely this: it isolates its
 * contents from the surrounding paragraph's directionality, so an Arabic name inside an English
 * sentence occupies one slot and stays in it. The alternative is wrapping every value in U+2068 /
 * U+2069 by hand, which works and is unreadable.
 *
 * So: never build a user-facing sentence from a translated template with `.replace()` when any
 * substituted value can be a name, a clinic, or anything else the user typed. Use this.
 */
export function interpolate(template: string, values: Record<string, ReactNode>): ReactNode[] {
  // Split on the placeholders themselves, keeping them, so the parts alternate literal/placeholder
  // without needing to scan twice or assume an order.
  const parts = template.split(/(\{[a-zA-Z0-9_]+\})/g);

  return parts.map((part, index) => {
    const match = /^\{([a-zA-Z0-9_]+)\}$/.exec(part);
    if (match === null) return <span key={index}>{part}</span>;

    const name = match[1];
    const value = name === undefined ? undefined : values[name];
    // An unknown placeholder renders as itself rather than disappearing. A missing name silently
    // becoming an empty string is how a sentence turns into "rejected the transfer of : " and
    // reads as a rendering glitch instead of a missing argument.
    if (value === undefined) return <span key={index}>{part}</span>;

    return <bdi key={index}>{value}</bdi>;
  });
}
