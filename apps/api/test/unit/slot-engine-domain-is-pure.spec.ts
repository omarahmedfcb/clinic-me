import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

/**
 * `modules/appointments/domain/` imports nothing and reads no clock — enforced by scanning the
 * source, because purity is a property nothing checks at runtime.
 *
 * This is the guard with the least visible failure mode in the project. `domain/` importing Prisma
 * compiles cleanly, passes review, and passes every test on a machine that has an `apps/api/.env`
 * — and then cannot even load on CI, which has none, because `src/prisma/client.ts` reads
 * `APP_DATABASE_URL` at module scope. CLAUDE.md records four separate CI failures with that one
 * root cause. A `new Date()` is worse still: it never fails anywhere, it just makes a function
 * that claims to be deterministic quietly not be, which is the exact shape of the seed defect that
 * left a wrong figure in a Definition of Done for months.
 *
 * Every rule below was proven by deliberately breaking it and watching this file fail, then
 * reverting — see the commit message for the four contrasts.
 */

const DOMAIN = path.join(__dirname, "..", "..", "src", "modules", "appointments", "domain");

interface Rule {
  readonly name: string;
  readonly pattern: RegExp;
  readonly why: string;
}

const RULES: readonly Rule[] = [
  {
    name: "no database access",
    pattern: /from\s+["'][^"']*\/prisma\//,
    why:
      "src/prisma/client.ts reads APP_DATABASE_URL at module scope, so one import turns every " +
      "spec in this directory into an integration test that cannot load on CI.",
  },
  {
    name: "no framework",
    pattern: /from\s+["']@nestjs\//,
    why:
      "A NestJS exception thrown here would reach the WhatsApp agent, which has no HTTP in it. " +
      "Absence is a value in this layer, not an exception (ARCHITECTURE.md §12).",
  },
  {
    name: "no filesystem or network",
    pattern: /from\s+["']node:(fs|http|https|net|dns)["']/,
    why: "CLAUDE.md: the slot engine is pure. If it needs I/O, the design is wrong.",
  },
  {
    name: "no clock reading",
    pattern: /new Date\(\s*\)|Date\.now\(/,
    why:
      "`now` is a parameter (PHASE-2.md §7). A fixed input next to a clock read looks " +
      "deterministic and is not, which is worse than no guarantee because nobody rechecks it.",
  },
  {
    name: "no timezone literal",
    pattern: /["'][A-Za-z]+\/[A-Za-z_]+["']\s*(?![^\n]*\bfrom\b)/,
    why:
      "CLAUDE.md: Africa/Cairo appears in seed data only. The zone is a parameter sourced from " +
      "tenants.timezone, so the engine works for a clinic outside Egypt without a change.",
  },
];

/** Comments carry examples and prose that would trip the scanner; only real code is checked. */
function stripCommentsAndDocs(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

const domainFiles = readdirSync(DOMAIN).filter((f) => f.endsWith(".ts"));

describe("appointments/domain is pure", () => {
  /**
   * A scanner pointed at an empty directory passes every rule. Asserting the file list first is
   * what stops this whole file becoming a no-op after a refactor moves the engine elsewhere —
   * the failure mode a guard like this is most likely to have, and the least likely to be noticed.
   */
  it("is actually scanning the engine", () => {
    expect(domainFiles.sort()).toEqual([
      "day-plan.ts",
      "describe-day.ts",
      "generate-slots.ts",
      "interval.ts",
      "occupancy.ts",
      "transition.ts",
      "types.ts",
      "zoned-time.ts",
    ]);
  });

  describe.each(RULES)("$name", (rule: Rule) => {
    it.each(domainFiles)("%s obeys it", (file: string) => {
      const code = stripCommentsAndDocs(readFileSync(path.join(DOMAIN, file), "utf8"));
      const offending = code.split("\n").filter((line) => rule.pattern.test(line));
      expect({ file, why: rule.why, offending }).toEqual({ file, why: rule.why, offending: [] });
    });
  });
});
