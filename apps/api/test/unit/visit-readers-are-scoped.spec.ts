import { readFileSync } from "node:fs";
import path from "node:path";
import { sourceFiles, stripComments } from "../../scripts/route-capabilities.ts";

/**
 * Every read of `visits` goes through `visitScope`. A reader that does not fails the build.
 *
 * The failure this catches: a new query for visits that forgets drafts are private, and returns
 * another doctor's unfinished notes. Nothing else would notice — it compiles, it returns rows, and
 * the rows look right until two doctors have drafts on the same patient.
 *
 * Two named scopes count, not one: `appointmentDoctorScope` joined in PR 5, because reception is not
 * the draft's author and the author filter would hide the very thing Q14 exists to show. Both live
 * in `visit-scope.ts`, which is where a reader goes to find out what a scope actually permits.
 */

const API_ROOT = path.resolve(__dirname, "..", "..");
const READ = /\.visit\.(findMany|findFirst|findUnique|findUniqueOrThrow|findFirstOrThrow|count|aggregate)\b/g;

/** The scope module itself, and the writer that creates drafts before any scope can apply. */
const EXEMPT = new Set(["src/modules/clinical/visit-scope.ts"]);

function relative(file: string): string {
  return path.relative(API_ROOT, file).split(path.sep).join("/");
}

describe("every reader of `visits` is scoped", () => {
  const offenders: string[] = [];

  for (const file of sourceFiles(path.join(API_ROOT, "src"), [".ts"])) {
    const name = relative(file);
    if (EXEMPT.has(name)) continue;

    const source = stripComments(readFileSync(file, "utf8"));
    const reads = [...source.matchAll(READ)].length;
    if (reads === 0) continue;

    // Counted, not merely present. A file-level "does it mention visitScope" check passes when a
    // file has two readers and one of them loses its scope -- verified by removing exactly one and
    // watching the weaker version stay green, which is why this counts instead.
    const scopes = [...source.matchAll(/\b(?:visitScope|appointmentDoctorScope)\(/g)].length;
    if (scopes < reads) {
      offenders.push(
        `${name} reads visits ${reads}x but calls a scope helper only ${scopes}x ` +
          "(visitScope, or appointmentDoctorScope for the queue's own read)",
      );
    }
  }

  test("no unscoped reader exists", () => {
    expect(offenders).toEqual([]);
  });

  test("the guard can see the readers it is guarding, so an empty pass is impossible", () => {
    // Without this, deleting the regex or moving every reader would produce a green run that
    // checked nothing -- the failure mode this project has found five times in its own tooling.
    let readers = 0;
    for (const file of sourceFiles(path.join(API_ROOT, "src"), [".ts"])) {
      if (EXEMPT.has(relative(file))) continue;
      readers += [...stripComments(readFileSync(file, "utf8")).matchAll(READ)].length;
    }
    expect(readers).toBeGreaterThanOrEqual(5);
  });
});
