// A tenant binds itself in exactly one place: create_default_branch() (ruled 2026-10-27). In database
// code nothing else may set app.current_tenant_id, and in application code only withTenant() does.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const API = path.resolve(__dirname, "..", "..");
const SANCTIONED_SQL = { file: "prisma/migrations/20261027100000_branches/migration.sql", fn: "create_default_branch" };
const SANCTIONED_TS = "src/prisma/with-tenant.ts";
const BINDS_TENANT = /set_config\s*\(\s*['"]app\.current_tenant_id['"]|\bSET\s+(LOCAL\s+|SESSION\s+)?app\.current_tenant_id\b/i;

function filesUnder(dir: string, extension: RegExp): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "generated" ? [] : filesUnder(full, extension);
    return extension.test(entry.name) && !/\.spec\.ts$/.test(entry.name) ? [full] : [];
  });
}

const relative = (full: string) => path.relative(API, full).replace(/\\/g, "/");

/** Line numbers (1-based) of the sanctioned function's body, so a binding inside it is allowed. */
function sanctionedLines(sql: string): { from: number; to: number } {
  const start = sql.indexOf(`CREATE FUNCTION ${SANCTIONED_SQL.fn}()`);
  if (start === -1) throw new Error(`${SANCTIONED_SQL.fn} is gone from ${SANCTIONED_SQL.file}; update this guard deliberately`);
  const end = sql.indexOf("$$;", start);
  const lineAt = (offset: number) => sql.slice(0, offset).split("\n").length;
  return { from: lineAt(start), to: lineAt(end) };
}

function bindings(full: string): number[] {
  return readFileSync(full, "utf8")
    .split(/\r?\n/)
    .map((line, index) => ({ line: line.replace(/--.*$|\/\/.*$/, ""), number: index + 1 }))
    .filter(({ line }) => BINDS_TENANT.test(line))
    .map(({ number }) => number);
}

describe("a tenant binds itself in one sanctioned place", () => {
  test("no SQL under prisma/ binds the tenant, except inside create_default_branch()", () => {
    const offenders: string[] = [];
    for (const full of filesUnder(path.join(API, "prisma"), /\.sql$/)) {
      const file = relative(full);
      const allowed = file === SANCTIONED_SQL.file ? sanctionedLines(readFileSync(full, "utf8").replace(/\r\n/g, "\n")) : null;
      for (const line of bindings(full)) {
        if (allowed === null || line < allowed.from || line > allowed.to) offenders.push(`${file}:${line}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("the sanctioned function does bind the tenant, so this guard is checking something", () => {
    const full = path.join(API, SANCTIONED_SQL.file);
    const { from, to } = sanctionedLines(readFileSync(full, "utf8").replace(/\r\n/g, "\n"));
    expect(bindings(full).filter((line) => line >= from && line <= to).length).toBeGreaterThan(0);
  });

  test("no application code binds the tenant, except withTenant()", () => {
    const offenders = filesUnder(path.join(API, "src"), /\.ts$/)
      .filter((full) => relative(full) !== SANCTIONED_TS && bindings(full).length > 0)
      .map(relative);
    expect(offenders).toEqual([]);
    expect(bindings(path.join(API, SANCTIONED_TS)).length).toBeGreaterThan(0);
  });
});
