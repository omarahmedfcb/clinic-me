import { readFileSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { GENERATED_COLUMNS_BY_MODEL } from "../../src/prisma/tenant-scoping.extension.ts";

/**
 * `GENERATED_COLUMNS_BY_MODEL` is the extension's list of Postgres `GENERATED ALWAYS ... STORED`
 * columns, and it is hand-maintained. Until this spec existed, nothing checked it: a third
 * generated column could be added in `prisma/sql/` and simply not registered, and the only notice
 * would be a raw Postgres error reaching a user months later. The doc comment on the map said "add
 * a row here", which is a request, not a guard.
 *
 * Postgres already knows the real answer, so the map is made to agree with it rather than trusted.
 * `information_schema.columns.is_generated` is `'ALWAYS'` for exactly the stored generated columns
 * (identity columns are a different mechanism and are reported under `is_identity`, so they do not
 * appear here).
 *
 * The assertion runs in both directions on purpose. A one-way check is the easy mistake:
 *   - map ⊆ database  alone would let a new generated column go unguarded, which is the failure
 *                     this file exists to prevent.
 *   - database ⊆ map  alone would let a stale entry survive a column being dropped, quietly
 *                     rejecting a legitimate write forever after.
 *
 * It also closes the loop between the two naming worlds the map straddles. The extension matches on
 * the *Prisma* field name (`nameSearchAr`) because that is what an attempted write carries, while
 * Postgres knows only the *column* name (`name_search_ar`). Those are related solely by an `@map`
 * in schema.prisma, so this spec reads that `@map` and checks it, rather than assuming the two
 * halves of each entry were written to match.
 */

const SCHEMA_PATH = path.resolve(__dirname, "..", "..", "prisma", "schema.prisma");

function superuserUrl(): string {
  const url = process.env["DATABASE_URL"];
  if (!url) throw new Error("DATABASE_URL must be set (see setup-env.ts)");
  return url;
}

/** The body of `model X { ... }` in schema.prisma. */
function modelBlock(schema: string, model: string): string {
  const match = schema.match(new RegExp(`^model ${model} \\{$([\\s\\S]*?)^\\}$`, "m"));
  if (!match?.[1]) throw new Error(`schema.prisma has no "model ${model}" block.`);
  return match[1];
}

/** The `@@map("...")` table name for a model. Every model in this schema has one. */
function tableNameOf(schema: string, model: string): string {
  const match = modelBlock(schema, model).match(/@@map\("([^"]+)"\)/);
  if (!match?.[1]) {
    throw new Error(
      `model ${model} in schema.prisma has no @@map(). This spec resolves Prisma model names to ` +
        "Postgres table names through @@map, so a model without one cannot be checked.",
    );
  }
  return match[1];
}

/** The `@map("...")` column name for one field of a model. */
function columnNameOf(schema: string, model: string, field: string): string {
  const line = modelBlock(schema, model)
    .split("\n")
    .find((candidate) => new RegExp(`^\\s*${field}\\s`).test(candidate));
  if (line === undefined) {
    throw new Error(
      `GENERATED_COLUMNS_BY_MODEL registers ${model}.${field}, but schema.prisma's model ${model} ` +
        "has no such field. The map's Prisma-side name is wrong, or the field was renamed.",
    );
  }
  const match = line.match(/@map\("([^"]+)"\)/);
  if (!match?.[1]) {
    throw new Error(
      `${model}.${field} has no @map() in schema.prisma, so its Postgres column name cannot be ` +
        "resolved. A generated column is written by hand in prisma/sql/ and is always snake_case, " +
        "so it should always carry an explicit @map().",
    );
  }
  return match[1];
}

describe("GENERATED_COLUMNS_BY_MODEL conformance", () => {
  let schema: string;
  let client: Client;
  let actual: Set<string>;

  beforeAll(async () => {
    schema = readFileSync(SCHEMA_PATH, "utf8");
    client = new Client({ connectionString: superuserUrl() });
    await client.connect();

    const { rows } = await client.query<{ table_name: string; column_name: string }>(
      `SELECT c.table_name, c.column_name
         FROM information_schema.columns c
         JOIN information_schema.tables t
           ON t.table_schema = c.table_schema AND t.table_name = c.table_name
        WHERE c.table_schema = 'public'
          AND t.table_type = 'BASE TABLE'
          AND c.is_generated = 'ALWAYS'`,
    );
    actual = new Set(rows.map((row) => `${row.table_name}.${row.column_name}`));
  });

  afterAll(async () => {
    await client?.end();
  });

  test("the database has generated columns at all, so an empty result cannot pass silently", () => {
    // Without this, every other assertion here would still pass against a database where the
    // constraints SQL never ran -- two empty sets match perfectly.
    expect(actual.size).toBeGreaterThan(0);
  });

  test("every registered entry names a real field and column in schema.prisma", () => {
    for (const [model, columns] of GENERATED_COLUMNS_BY_MODEL) {
      for (const { field, column } of columns) {
        expect({ model, field, column }).toEqual({ model, field, column: columnNameOf(schema, model, field) });
      }
    }
  });

  test("the map and the database name exactly the same generated columns", () => {
    const registered = new Set<string>();
    for (const [model, columns] of GENERATED_COLUMNS_BY_MODEL) {
      const table = tableNameOf(schema, model);
      for (const { column } of columns) {
        registered.add(`${table}.${column}`);
      }
    }

    const unguarded = [...actual].filter((c) => !registered.has(c)).sort();
    const stale = [...registered].filter((c) => !actual.has(c)).sort();

    expect({ unguarded, stale }).toEqual({ unguarded: [], stale: [] });
  });
});
