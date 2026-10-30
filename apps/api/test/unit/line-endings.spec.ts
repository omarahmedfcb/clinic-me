import { readFileSync } from "node:fs";
import path from "node:path";
import { sourceFiles } from "../../scripts/route-capabilities.ts";

// A carriage return not ending a line makes git store a source file as non-text, so every later
// change to it diffs as the whole file. KNOWN lists any exception still owed a fix; none remain.
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const KNOWN: string[] = [];
const ROOTS = ["apps/api/src", "apps/api/test", "apps/api/prisma", "apps/api/scripts", "apps/web/src"];

function strayCarriageReturns(): string[] {
  const offenders: string[] = [];
  for (const root of ROOTS) {
    for (const file of sourceFiles(path.join(REPO_ROOT, root), [".ts", ".tsx"])) {
      const bytes = readFileSync(file);
      const stray = bytes.some((byte, i) => byte === 13 && bytes[i + 1] !== 10);
      if (stray) offenders.push(path.relative(REPO_ROOT, file).split(path.sep).join("/"));
    }
  }
  return offenders.sort();
}

describe("source files end their lines one way", () => {
  const offenders = strayCarriageReturns();

  test("no source file carries a carriage return that does not end a line", () => {
    expect(offenders.filter((file) => !KNOWN.includes(file))).toEqual([]);
  });

  test("every known exception is still one, so the list cannot go stale", () => {
    expect(KNOWN.filter((file) => !offenders.includes(file))).toEqual([]);
  });
});
