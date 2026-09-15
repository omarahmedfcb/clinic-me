import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * **D7: derived money is read from the database, never recomputed in a service.**
 *
 * `payments.remaining_minor` is `GENERATED ALWAYS AS (amount_due_minor - amount_paid_minor) STORED`.
 * D7's reasoning is that application-computed derived money drifts — silently, financially, and is
 * "discovered by a customer".
 *
 * ## Why this guard is static, which is not the shape this project prefers
 *
 * It was written as a behavioural test first, and **the behavioural test could not fail.** Changing
 * `sum(remaining_minor)` to `sum(amount_due_minor - amount_paid_minor)` in the balance query left
 * all 21 integration tests green.
 *
 * That is not a weak test — it is a property of the thing being guarded. A `STORED` generated column
 * is maintained by Postgres on every write, so the column and its own defining expression **can
 * never disagree**. There is no database state in which the two answers differ, therefore no
 * behavioural test can distinguish them, therefore the only honest guard is one that reads the
 * source.
 *
 * Recorded rather than quietly swapped, because "prove the guard by breaking what it guards" would
 * otherwise have produced a false pass and a claim in a commit message that was not true.
 *
 * ## What it forbids, and what it does not
 *
 * Recomputing `amount_due_minor - amount_paid_minor` anywhere in application code. It does **not**
 * forbid the migration that defines the column, which lives in `prisma/sql/` and is not scanned.
 * Comments are stripped before matching, so the prose above — and the identical sentence in
 * `patients.service.ts` — does not trip it. The same technique `seed-determinism.spec.ts` uses so
 * that prose about `new Date()` is not mistaken for a call.
 */

const SRC = join(__dirname, "..", "..", "src");

/** Block and line comments removed, so documentation of the rule is not mistaken for a breach. */
function codeOnly(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
}

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    // `generated/` is Prisma's output and is not ours to police.
    if (entry === "generated") continue;
    if (statSync(full).isDirectory()) found.push(...sourceFiles(full));
    else if (/\.ts$/.test(entry) && !/\.spec\.ts$/.test(entry)) found.push(full);
  }
  return found;
}

/**
 * The subtraction, in the spellings it could plausibly be written in — SQL snake_case inside a raw
 * query, and camelCase in TypeScript against the Prisma client. Whitespace-tolerant.
 */
const RECOMPUTATIONS = [
  /amount_due_minor\s*-\s*amount_paid_minor/,
  /amountDueMinor\s*-\s*amountPaidMinor/,
];

/**
 * Mentions that are not violations, each with the reason it is allowed.
 *
 * A registry rather than a cleverer regex, for the reason `own-capability-enforcement.ts` gives:
 * an exception with a name and a reason survives review, while a pattern tuned until it goes quiet
 * stops meaning anything. **A file that is not listed here must not contain the subtraction at
 * all** — including in a string, because a template literal is one edit away from being a query.
 */
const PERMITTED = new Map<string, string>([
  // Empty since 2026-09-10. `tenant-scoping.extension.ts` held the only entry -- it named the
  // subtraction inside the error it raised when application code tried to write
  // `remaining_minor` -- and Phase 5 PR 5 removed that column, so the mention went with it. This
  // test caught the stale entry, which is the direction it was written for.
]);

describe("D7 — derived money is read, not recomputed", () => {
  const files = sourceFiles(SRC);

  test("the scan sees a real source tree — otherwise everything below is vacuous", () => {
    expect(files.length).toBeGreaterThan(30);
  });

  test("no service recomputes remaining_minor", () => {
    const offenders = files
      .map((file) => ({
        file: file.slice(SRC.length + 1).replace(/\\/g, "/"),
        code: codeOnly(readFileSync(file, "utf8")),
      }))
      .filter(({ code }) => RECOMPUTATIONS.some((pattern) => pattern.test(code)))
      .filter(({ file }) => !PERMITTED.has(file))
      .map(({ file }) => file);

    expect(offenders).toEqual([]);
  });

  test("every permitted mention still exists, so the allow-list cannot outlive its reason", () => {
    // The other direction, which the capability registry taught: an entry that no longer describes
    // anything is a licence nobody notices has been left lying around.
    const stale = [...PERMITTED.keys()].filter((permitted) => {
      const full = join(SRC, permitted);
      const code = codeOnly(readFileSync(full, "utf8"));
      return !RECOMPUTATIONS.some((pattern) => pattern.test(code));
    });
    expect(stale).toEqual([]);
  });

  test("the balance query reads the database-computed value, so the rule is followed rather than avoided", () => {
    // Non-vacuity for the test above: a codebase that had removed the balance query entirely would
    // satisfy "nobody recomputes it" while answering nothing.
    //
    // This matched `sum(remaining_minor)` until Phase 5 PR 5 removed that column. The rule did not
    // change — D7 as amended says *database-computed*, not specifically `GENERATED` — and the
    // computation moved to the `visit_charge_balances` view, because a balance is a sum across
    // payment rows and no generated column can express a cross-table aggregate.
    const service = readFileSync(join(SRC, "modules", "patients", "patients.service.ts"), "utf8");
    expect(codeOnly(service)).toMatch(/sum\(b\.balance_minor\)/);
  });
});
