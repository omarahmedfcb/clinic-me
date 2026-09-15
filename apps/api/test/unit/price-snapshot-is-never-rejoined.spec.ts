import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

/**
 * `services.price_minor` is read **only to populate a new row** — `PHASE-5-DESIGN.md` §2.2.
 *
 * The rule exists because `services` is a mutable row and clinic-managed services is the feature
 * that starts mutating it. Any query that reaches a *past* amount by joining to it re-prices
 * history the first time an admin edits the catalogue: silently, and unrecoverably, because the
 * old value was never stored. What an appointment cost is `appointments.quoted_price_minor`, taken
 * at booking; what a visit was charged will be the Phase 5 charge lines.
 *
 * §2.2 says the rule "should be enforced rather than documented", and this is the mechanical form.
 * A comment saying "do not join here" is the weakest guard this project has, and the failure it
 * would miss is invisible: the join compiles, returns a number, renders correctly, and is wrong
 * only for rows whose service has since been re-priced — which is nobody's test data.
 *
 * ## What is banned, precisely
 *
 * Reaching `priceMinor` **through the `service` relation** — the shape a query rooted at an
 * appointment, visit or payment uses to ask "what did this cost". Both forms are caught:
 *
 *   service: { select: { priceMinor: true } }   // named
 *   service: true                               // the whole row, price included
 *
 * ## What is deliberately still allowed
 *
 * Reading `services.price_minor` directly, unjoined — the catalogue screen showing today's prices,
 * and the booking path copying the current price onto a new appointment. Those are the two
 * legitimate readers and both live in `src/modules/services/` or read the model at its root.
 * `service: { select: { durationMinutes: true, bufferMinutes: true } }` is also untouched: the slot
 * engine needs those and they are not money.
 *
 * **If you are here because this test failed:** the fix is almost never to add your file to the
 * allowlist. It is to read the amount that was recorded at the time — `quotedPriceMinor` on the
 * appointment — rather than the price the service happens to carry today.
 */

/** Files permitted to reach price through the relation. Empty on purpose: none should need to. */
const ALLOWED = new Set<string>([]);

const API_ROOT = path.resolve(__dirname, "..", "..");

function sourceFiles(directory: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(directory)) {
    if (entry === "node_modules" || entry === "generated" || entry === "dist") continue;
    const full = path.join(directory, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (full.endsWith(".ts")) out.push(full);
  }
  return out;
}

/**
 * The text of each `service: { ... }` block, brace-balanced.
 *
 * A regex cannot do this: `service: { select: { priceMinor: true } }` contains a nested object, and
 * `[^}]*` stops at the first inner brace — which would make the guard silently miss the one shape
 * it exists to catch. Counting braces is a few lines and cannot be fooled that way.
 */
function serviceRelationBlocks(source: string): string[] {
  const blocks: string[] = [];
  const opener = /\bservice:\s*\{/g;

  for (let match = opener.exec(source); match !== null; match = opener.exec(source)) {
    let depth = 1;
    let index = match.index + match[0].length;
    while (index < source.length && depth > 0) {
      if (source[index] === "{") depth += 1;
      else if (source[index] === "}") depth -= 1;
      index += 1;
    }
    blocks.push(source.slice(match.index, index));
  }

  return blocks;
}

describe("the quoted price is a snapshot, and nothing re-derives it from the service", () => {
  const files = sourceFiles(path.join(API_ROOT, "src")).map((file) => ({
    relative: path.relative(API_ROOT, file),
    source: readFileSync(file, "utf8"),
  }));

  it("scans a source tree that actually contains the models, so a pass means something", () => {
    // Without this, a broken path or an over-eager exclusion makes every assertion below pass by
    // scanning nothing at all -- a green run that checked no code.
    expect(files.length).toBeGreaterThan(30);
    expect(files.some(({ source }) => source.includes("tx.appointment"))).toBe(true);
  });

  it("no query selects priceMinor through the service relation", () => {
    const offenders = files.flatMap(({ relative, source }) =>
      ALLOWED.has(relative)
        ? []
        : serviceRelationBlocks(source)
            .filter((block) => block.includes("priceMinor"))
            .map((block) => `${relative}: ${block.replace(/\s+/g, " ")}`),
    );

    expect(offenders).toEqual([]);
  });

  it("no query pulls the whole service row, which would carry the price with it", () => {
    const offenders = files.flatMap(({ relative, source }) =>
      ALLOWED.has(relative) || !/\bservice:\s*true\b/.test(source) ? [] : [relative],
    );

    expect(offenders).toEqual([]);
  });
});
