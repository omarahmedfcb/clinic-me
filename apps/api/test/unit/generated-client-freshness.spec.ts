import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * Fails when `src/generated/prisma/` was generated from a different `schema.prisma` than the one
 * on disk -- that is, when somebody changed the schema, or pulled a change to it, and did not
 * re-run `npx prisma generate`.
 *
 * This exists because of a real morning. On 2026-08-25 this machine pulled the D19 patient name
 * split from a second machine. `src/generated/` is gitignored, so no pull updates it; the client
 * still described a `full_name` column that no longer existed. `npm run typecheck` stayed green
 * anyway, because the write paths were all behind `as never` and nothing was checking them. Two
 * separate silences agreed with each other, and the first symptom was a type error in a file
 * nobody had touched.
 *
 * The type-checking half of that is fixed (src/prisma/injected.ts), so a stale client is now far
 * more likely to be noisy than silent. This is the other half: say so directly, rather than
 * leaving it to be inferred from a confusing error somewhere else.
 *
 * ## Why the comparison is on content, not timestamps
 *
 * An mtime check -- "is schema.prisma newer than the generated directory" -- is the obvious
 * implementation and is wrong often enough to be worse than nothing. A fresh clone writes every
 * file at checkout time in no guaranteed order; switching branches rewrites mtimes without
 * changing content. Either produces a failure that regenerating does not explain.
 *
 * Prisma embeds the schema it generated from in the client, as `inlineSchema`. Comparing against
 * that answers the actual question -- "was this client built from this schema" -- and is immune to
 * both. It is read as text rather than imported, because the file carrying it is explicitly marked
 * internal and must not be imported.
 *
 * Whitespace is normalised before comparing because Prisma stores a *formatted* copy: it realigns
 * field declarations, so the embedded text differs from the file on disk by spacing alone even
 * when they are the same schema. Nothing that matters here -- a renamed field, a changed type, a
 * changed `@map`, an added model -- survives that normalisation.
 */

const API_ROOT = path.resolve(__dirname, "..", "..");
const SCHEMA_PATH = path.join(API_ROOT, "prisma", "schema.prisma");
const CLIENT_INTERNALS = path.join(API_ROOT, "src", "generated", "prisma", "internal", "class.ts");

const REGENERATE = "Run `npx prisma generate` in apps/api.";

/** Collapses runs of spaces/tabs and trims each line, so only meaningful differences survive. */
function normalise(schema: string): string {
  return schema
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trim().replace(/[ \t]+/g, " "))
    .join("\n")
    .trim();
}

/**
 * Reads the JSON string literal that follows `"inlineSchema": ` in the generated client, scanning
 * to its closing quote so that escaped quotes inside the schema text do not end it early.
 */
function embeddedSchema(source: string): string {
  const marker = '"inlineSchema": ';
  const start = source.indexOf(marker);
  if (start === -1) {
    throw new Error(
      'The generated Prisma client no longer contains an "inlineSchema" field, so this check ' +
        "cannot tell whether it is current. That almost certainly means a Prisma upgrade changed " +
        "the generated layout. Do not delete this test to get green -- find where the client now " +
        "records its source schema and update embeddedSchema() to read it.",
    );
  }
  let end = start + marker.length + 1;
  for (; end < source.length; end++) {
    if (source[end] === "\\") {
      end++;
      continue;
    }
    if (source[end] === '"') break;
  }
  return JSON.parse(source.slice(start + marker.length, end + 1)) as string;
}

describe("generated Prisma client is current", () => {
  test("the client exists at all", () => {
    // A fresh clone has no generated client and nothing compiles. Naming that here means the
    // failure says which command to run, instead of a wall of "Cannot find module" errors.
    if (!existsSync(CLIENT_INTERNALS)) {
      throw new Error(`There is no generated Prisma client at ${CLIENT_INTERNALS}. ${REGENERATE}`);
    }
  });

  test("it was generated from the schema.prisma currently on disk", () => {
    const onDisk = normalise(readFileSync(SCHEMA_PATH, "utf8"));
    const generatedFrom = normalise(embeddedSchema(readFileSync(CLIENT_INTERNALS, "utf8")));

    if (onDisk === generatedFrom) return;

    // Point at the first divergence rather than dumping two 48 KB schemas into the output.
    let at = 0;
    while (at < Math.min(onDisk.length, generatedFrom.length) && onDisk[at] === generatedFrom[at]) at++;
    const excerpt = (text: string): string => text.slice(Math.max(0, at - 120), at + 120);

    throw new Error(
      `The generated Prisma client is stale: it was built from a different schema.prisma. ${REGENERATE}\n\n` +
        `First difference at character ${at}:\n\n` +
        `  schema.prisma on disk:\n    ...${excerpt(onDisk)}...\n\n` +
        `  what the client was generated from:\n    ...${excerpt(generatedFrom)}...\n`,
    );
  });
});
