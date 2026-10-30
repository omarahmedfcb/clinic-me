// Every model tenant-scoped-models.ts calls "scoped" has RLS enabled AND forced, with a tenant_isolation
// policy that checks both reads and writes. Derived from the registry, so a new table is covered unasked.
import { readFileSync } from "node:fs";
import path from "node:path";
import { Prisma } from "../../src/generated/prisma/client.ts";
import { prisma } from "../../src/prisma/client.ts";
import { isTenantScoped } from "../../src/prisma/tenant-scoped-models.ts";

const schema = readFileSync(path.resolve(__dirname, "..", "..", "prisma", "schema.prisma"), "utf8");
const tableOf = (model: string): string => {
  const table = new RegExp(`^model ${model} \\{[\\s\\S]*?@@map\\("(\\w+)"\\)`, "m").exec(schema)?.[1];
  if (table === undefined) throw new Error(`${model} has no @@map in schema.prisma`);
  return table;
};

afterAll(async () => {
  await prisma.$disconnect();
});

test("every scoped table has RLS enabled, forced, and a tenant_isolation policy on reads and writes", async () => {
  const tables = Object.values(Prisma.ModelName).filter(isTenantScoped).map(tableOf);
  const rows = await prisma.$queryRaw<{ table: string; enabled: boolean; forced: boolean; using: boolean; checks: boolean }[]>`
    SELECT c.relname AS table, c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced,
           COALESCE(bool_or(p.polqual IS NOT NULL), false) AS using,
           COALESCE(bool_or(p.polwithcheck IS NOT NULL), false) AS checks
      FROM pg_class c
      LEFT JOIN pg_policy p ON p.polrelid = c.oid AND p.polname = 'tenant_isolation'
     WHERE c.relnamespace = 'public'::regnamespace AND c.relname = ANY (${tables})
     GROUP BY c.relname, c.relrowsecurity, c.relforcerowsecurity`;

  expect(rows.map((row) => row.table).sort()).toEqual([...tables].sort());
  const gaps = rows.filter((row) => !(row.enabled && row.forced && row.using && row.checks)).map((row) => row.table);
  expect(gaps).toEqual([]);
  // The three tables the branches migration added are among them, by name.
  expect(tables).toEqual(expect.arrayContaining(["branches", "membership_branches", "branch_requests"]));
});
