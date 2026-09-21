import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * **Every file `docs/SECURITY-REVIEW.md` cites exists.**
 *
 * The document's whole claim is that each OWASP item names the test or policy that answers it. A
 * citation pointing at a renamed or deleted file makes it worse than no document: it reads as
 * evidence, and the reader has no reason to check. This is the check.
 *
 * It also counts the citations, because a scanner that stopped matching would find none and pass.
 */
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const REVIEW = path.join(REPO_ROOT, "docs", "SECURITY-REVIEW.md");

/** Backticked paths that look like repository files — `apps/…`, `docs/…`, `scripts/…`. */
function citedPaths(): string[] {
  const text = readFileSync(REVIEW, "utf8");
  const found = new Set<string>();
  for (const match of text.matchAll(/`((?:apps|docs|scripts)\/[A-Za-z0-9._/-]+)`/g)) {
    found.add(match[1] as string);
  }
  return [...found];
}

describe("the security review cites files that exist", () => {
  test("every cited path resolves", () => {
    const missing = citedPaths().filter((cited) => !existsSync(path.join(REPO_ROOT, cited)));
    expect(missing).toEqual([]);
  });

  test("it cites enough to be a walk rather than a gesture", () => {
    // Ten items, each meant to name what answers it. Far fewer than one citation per item would
    // mean the document had quietly become prose.
    expect(citedPaths().length).toBeGreaterThanOrEqual(20);
  });

  test("every OWASP item is present, and the unanswered ones are visible", () => {
    const text = readFileSync(REVIEW, "utf8");
    for (let item = 1; item <= 10; item += 1) {
      expect(text).toContain(`## A${String(item).padStart(2, "0")} —`);
    }
    /*
     * The stated count of open items matches the notes that carry them.
     *
     * The five gaps this document opened with were closed on 2026-09-19, so a floor of three
     * `Unanswered` notes would now fail for the right reason in the wrong direction. What has to
     * stay true is narrower and more durable: the number the closing section claims is the number
     * of notes actually present — so an item cannot be closed by deleting its note, and cannot be
     * hidden by keeping the note and quietly editing the summary.
     */
    const open = (text.match(/\*\*Still open:/g) ?? []).length;
    const stated = /\*\*Open items: (\d+)\.\*\*/.exec(text);
    expect(stated).not.toBeNull();
    expect(Number(stated?.[1])).toBe(open);
  });
});
