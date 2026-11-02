// down.sql restores two functions by copying them. A copy that drifted from the original would leave
// the reversed database subtly different from the one before, so they are compared byte for byte.
import { readFileSync } from "node:fs";
import path from "node:path";

const MIGRATIONS = path.resolve(__dirname, "..", "..", "prisma", "migrations");
const read = (migration: string, file = "migration.sql") => readFileSync(path.join(MIGRATIONS, migration, file), "utf8").replace(/\r\n/g, "\n");

function functionText(sql: string, name: string, signature = "()"): string {
  const start = sql.indexOf(`FUNCTION ${name}${signature}`);
  if (start === -1) throw new Error(`${name} not found`);
  const end = sql.indexOf("$$", sql.indexOf("$$", start) + 2);
  return sql.slice(start, sql.indexOf("\n", end));
}

describe("the branches down migration", () => {
  const down = read("20261027100000_branches", "down.sql");

  test("restores allocate_receipt_number() exactly as payments_become_receipts defined it", () => {
    expect(functionText(down, "allocate_receipt_number")).toBe(
      functionText(read("20260910060000_payments_become_receipts"), "allocate_receipt_number"),
    );
  });

  test("restores audit_row_change() exactly as audit_triggers defined it", () => {
    expect(functionText(down, "audit_row_change")).toBe(functionText(read("20260822170200_audit_triggers"), "audit_row_change"));
  });

  test("refuses before it changes anything", () => {
    const refusal = down.indexOf("RAISE EXCEPTION 'branches down:");
    const firstChange = down.search(/^(UPDATE|DROP|ALTER|CREATE|DELETE)\b/m);
    expect(refusal).toBeGreaterThan(-1);
    expect(refusal).toBeLessThan(firstChange);
  });
});

describe("the step 4b stage 1 down migration", () => {
  const down = read("20261029070000_branches_interim_accepts_named_branch", "down.sql");
  const branches = read("20261027100000_branches");

  for (const name of ["interim_fill_sole_branch", "allocate_receipt_number"]) {
    test(`restores ${name}() exactly as the branches migration defined it`, () => {
      expect(functionText(down, name)).toBe(functionText(branches, name));
    });
  }
});

describe("the step 4b stage 5 down migration", () => {
  const down = read("20261029180500_branches_stage5_retire_interim", "down.sql");
  const stage1 = read("20261029070000_branches_interim_accepts_named_branch");
  const branches = read("20261027100000_branches");

  for (const name of ["interim_fill_sole_branch", "allocate_receipt_number"]) {
    test(`restores ${name}() exactly as stage 1 left it`, () => {
      expect(functionText(down, name)).toBe(functionText(stage1, name));
    });
  }

  test("restores interim_sole_branch() exactly as the branches migration defined it", () => {
    const signature = "(p_tenant_id uuid, p_table text)";
    expect(functionText(down, "interim_sole_branch", signature)).toBe(functionText(branches, "interim_sole_branch", signature));
  });

  test("restores both interim triggers", () => {
    for (const table of ["appointments", "schedule_templates"]) {
      expect(down).toContain(`CREATE TRIGGER ${table}_interim_fill_sole_branch BEFORE INSERT ON ${table}\n  FOR EACH ROW EXECUTE FUNCTION interim_fill_sole_branch();`);
    }
  });
});
