import { readFileSync } from "node:fs";
import path from "node:path";
import { sourceFiles, stripComments } from "../../scripts/route-capabilities.ts";

/**
 * **No stored enum value reaches a screen untranslated** — the founder's ruling of 2026-09-09, after
 * the patient detail page showed `MALE` and `ACTIVE` in the middle of an Arabic record.
 *
 * ## Why the field list is derived and not written down
 *
 * The tempting version of this guard is a list of field names someone believes carry enums. That
 * list is wrong the first time a column changes type, and wrong silently. So the fields are read out
 * of `schema.prisma`: every enum declared there, and every model field typed by one. A new enum
 * column is covered the day it is added, without anyone remembering this file exists.
 *
 * ## What counts as "reaching the screen"
 *
 * Three shapes, and they are narrow on purpose — a wide match would flag `status={entry.status}`
 * passed to `<StatusBadge>`, which is a component whose whole job is to translate it, and a guard
 * that cries wolf gets an allow-list bolted on until it means nothing.
 *
 *   value={patient.status}          a labelled row rendering the value
 *   render: (row) => row.status     a table cell returning it raw
 *   >{patient.status}<              a bare JSX text child
 *
 * Each is the value going straight to a human. Passing it to a component, or into `t(...)`, is not
 * matched — those are the two legitimate things to do with it.
 */

const API_ROOT = path.resolve(__dirname, "..", "..");
const REPO_ROOT = path.resolve(API_ROOT, "..", "..");
const WEB_FEATURES = path.join(REPO_ROOT, "apps", "web", "src", "features");

/** Every field in `schema.prisma` whose type is one of the schema's own enums. */
function enumFieldNames(): Set<string> {
  const schema = readFileSync(path.join(API_ROOT, "prisma", "schema.prisma"), "utf8");
  const enums = new Set(
    [...schema.matchAll(/^enum\s+(\w+)\s*\{/gm)].map((match) => match[1] as string),
  );
  const fields = new Set<string>();
  for (const line of schema.split(/\r?\n/)) {
    const match = /^\s{2}(\w+)\s+(\w+)(\?|\[\])?\s/.exec(line);
    if (match !== null && enums.has(match[2] as string)) fields.add(match[1] as string);
  }
  return fields;
}

/**
 * `gender` is a `String?` column and so is not in the derived set — yet `MALE` on an Arabic record
 * is the value that produced this ruling. Listed by hand, with the reason, because the alternative
 * is a guard that misses the exact defect it was written for. Anything else added here needs the
 * same justification: a closed set of stored values that a person reads.
 */
const CLOSED_STRING_COLUMNS = ["gender"];

const FIELDS = new Set([...enumFieldNames(), ...CLOSED_STRING_COLUMNS]);

function offendersIn(source: string): string[] {
  const text = stripComments(source);
  const names = [...FIELDS].join("|");
  const found: string[] = [];

  const shapes: [string, RegExp][] = [
    ["value={x.enum}", new RegExp(`value=\\{\\s*\\w+\\.(?:${names})\\s*\\}`, "g")],
    ["render returning x.enum", new RegExp(`=>\\s*\\w+\\.(?:${names})\\s*[,}\\n]`, "g")],
    ["bare JSX child {x.enum}", new RegExp(`>\\s*\\{\\s*\\w+\\.(?:${names})\\s*\\}\\s*<`, "g")],
  ];
  for (const [shape, pattern] of shapes) {
    for (const match of text.matchAll(pattern)) found.push(`${shape}: ${match[0].trim()}`);
  }
  return found;
}

describe("no stored enum reaches a screen untranslated", () => {
  test("the field list came from the schema and is not empty", () => {
    // Without this, a regex that stopped matching `schema.prisma` would produce an empty field set,
    // an empty offender list and a green run that checked nothing.
    expect(FIELDS.size).toBeGreaterThan(10);
    // The two the ruling was about, plus one from each end of the derived set — so a regex that
    // stopped parsing the schema fails here rather than quietly guarding nothing.
    for (const field of ["status", "gender", "relationshipToContact", "eventType"]) {
      expect([...FIELDS]).toContain(field);
    }
  });

  test("the scan reads the screens it is guarding", () => {
    const files = sourceFiles(WEB_FEATURES, [".tsx"]).filter((file) => !file.endsWith(".spec.tsx"));
    expect(files.length).toBeGreaterThan(15);
  });

  test("no screen renders a stored enum value directly", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(WEB_FEATURES, [".tsx"])) {
      if (file.endsWith(".spec.tsx")) continue;
      const relative = path.relative(REPO_ROOT, file).split(path.sep).join("/");
      for (const offence of offendersIn(readFileSync(file, "utf8"))) {
        offenders.push(`${relative} — ${offence}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
