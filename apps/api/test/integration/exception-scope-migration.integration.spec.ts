// The exception-scope migration's backfill, run on old-shape rows in a throwaway database this spec
// creates and drops: reversing it under clinic_os_test would pull a column from beneath later specs.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { Client } from "pg";
import { runDownMigration } from "../../scripts/down-migration.ts";

const NAME = "20261029155000_schedule_exception_scope";
const API_ROOT = path.resolve(__dirname, "..", "..");
const MIGRATIONS = path.join(API_ROOT, "prisma", "migrations");
const DATABASE = "clinic_os_exception_scope";
const serverUrl = process.env["TEST_DATABASE_URL"] ?? "";
const url = (() => {
  const target = new URL(serverUrl);
  target.pathname = `/${DATABASE}`;
  return target.toString();
})();

async function query<T = Record<string, unknown>>(text: string, params: unknown[] = [], on = url): Promise<T[]> {
  const client = new Client({ connectionString: on });
  await client.connect();
  try {
    await client.query("SELECT set_config('app.current_actor_id', system_actor_id()::text, false)").catch(() => undefined);
    return (await client.query(text, params)).rows as T[];
  } finally {
    await client.end();
  }
}

const deploy = (): void => {
  execFileSync(process.execPath, [require.resolve("prisma/build/index.js"), "migrate", "deploy"], {
    cwd: API_ROOT,
    env: { ...process.env, DATABASE_URL: url },
    stdio: "pipe",
  });
};

const failure = async (text: string): Promise<string> => {
  try {
    await query(text);
    return "no error";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
};

const describeRoundTrip = process.env["TEST_CANNOT_CREATE_DATABASES"] === "1" ? describe.skip : describe;

describeRoundTrip("the exception-scope migration: the backfill as ruled, and the constraints it leaves", () => {
  const tenant = randomUUID();
  const doctor = randomUUID();
  const rows = { named: randomUUID(), extra: randomUUID(), absence: randomUUID(), closure: randomUUID() };
  let defaultBranch = "";

  beforeAll(async () => {
    await query(`DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`, [], serverUrl);
    await query(`CREATE DATABASE ${DATABASE}`, [], serverUrl);
    deploy();
    for (const later of ["20261029180500_branches_stage5_retire_interim", "20261029175000_orphaned_audit_read_by_transaction", "20261029163000_audit_scope"]) {
      await runDownMigration(url, MIGRATIONS, later);
    }
    await runDownMigration(url, MIGRATIONS, NAME);
    await query(`
      INSERT INTO users (id, phone_e164, password_hash, full_name, status, updated_at) VALUES ('${doctor}', '+201009998877', 'x', 'Doctor', 'ACTIVE', now());
      INSERT INTO tenants (id, name, slug, phone, address, locale, currency, status, settings, updated_at, country) VALUES ('${tenant}', 'Clinic', 'scope-${tenant}', '+201000000001', 'Cairo', 'ar', 'EGP', 'ACTIVE', '{}', now(), 'EG');
      INSERT INTO memberships (id, user_id, tenant_id, role, status, updated_at) VALUES ('${doctor}', '${doctor}', '${tenant}', 'DOCTOR', 'ACTIVE', now());
      INSERT INTO doctors (id, tenant_id, membership_id, specialty, license_number, title, updated_at) VALUES ('${doctor}', '${tenant}', '${doctor}', 'General', 'L1', 'Dr.', now());`);
    defaultBranch = (await query<{ id: string }>("SELECT id FROM branches WHERE tenant_id = $1 AND is_default", [tenant]))[0]!.id;
    await query(`
      INSERT INTO schedule_exceptions (id, tenant_id, doctor_id, date, type, start_time, end_time, branch_id, updated_at) VALUES
        ('${rows.named}',   '${tenant}', '${doctor}', '2031-01-05', 'BLOCKED',            NULL,    NULL,    '${defaultBranch}', now()),
        ('${rows.extra}',   '${tenant}', '${doctor}', '2031-01-06', 'EXTRA_AVAILABILITY', '18:00', '20:00', NULL, now()),
        ('${rows.absence}', '${tenant}', '${doctor}', '2031-01-07', 'BLOCKED',            NULL,    NULL,    NULL, now()),
        ('${rows.closure}', '${tenant}', NULL,        '2031-01-08', 'HOLIDAY',            NULL,    NULL,    NULL, now());`);
    deploy();
  }, 240_000);

  afterAll(async () => {
    await query(`DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`, [], serverUrl);
  });

  test("each existing row gets the reach the ruling gives it", async () => {
    const stored = await query<{ id: string; scope: string; branch_id: string | null }>(
      "SELECT id, scope::text AS scope, branch_id FROM schedule_exceptions WHERE tenant_id = $1",
      [tenant],
    );
    const byId = Object.fromEntries(stored.map((r) => [r.id, { scope: r.scope, branch: r.branch_id }]));
    expect(byId[rows.named]).toEqual({ scope: "ONE_BRANCH", branch: defaultBranch });
    expect(byId[rows.extra]).toEqual({ scope: "ONE_BRANCH", branch: defaultBranch });
    expect(byId[rows.absence]).toEqual({ scope: "EVERY_BRANCH", branch: null });
    expect(byId[rows.closure]).toEqual({ scope: "EVERY_BRANCH", branch: null });
  });

  test("the database allows a null branch only with EVERY_BRANCH, and never for extra availability", async () => {
    const insert = (scope: string, branch: string, type = "BLOCKED", times = "NULL, NULL") =>
      failure(`INSERT INTO schedule_exceptions (id, tenant_id, date, type, start_time, end_time, branch_id, scope, updated_at)
               VALUES ('${randomUUID()}', '${tenant}', '2031-02-01', '${type}', ${times}, ${branch}, '${scope}', now())`);
    expect(await insert("EVERY_BRANCH", `'${defaultBranch}'`)).toContain("schedule_exceptions_branch_matches_scope");
    expect(await insert("ONE_BRANCH", "NULL")).toContain("schedule_exceptions_branch_matches_scope");
    expect(await insert("EVERY_BRANCH", "NULL", "EXTRA_AVAILABILITY", "'18:00', '19:00'")).toContain("schedule_exceptions_extra_availability_one_branch");
  });
});
