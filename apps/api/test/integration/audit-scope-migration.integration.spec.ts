// The audit-scope migration on rows written before it, in a throwaway database this spec creates and
// drops: a recorded branch is ONE_BRANCH, no branch is BEFORE_BRANCHES, and no UPDATE ran (D5).
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { Client } from "pg";
import { runDownMigration } from "../../scripts/down-migration.ts";

const NAME = "20261029163000_audit_scope";
const LATER = ["20261029180500_branches_stage5_retire_interim", "20261029175000_orphaned_audit_read_by_transaction"];
const reverse = async (): Promise<void> => {
  for (const later of LATER) await runDownMigration(url, MIGRATIONS, later);
  await runDownMigration(url, MIGRATIONS, NAME);
};
const API_ROOT = path.resolve(__dirname, "..", "..");
const MIGRATIONS = path.join(API_ROOT, "prisma", "migrations");
const DATABASE = "clinic_os_audit_scope";
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

const describeRoundTrip = process.env["TEST_CANNOT_CREATE_DATABASES"] === "1" ? describe.skip : describe;

describeRoundTrip("the audit-scope migration: existing rows say what they recorded, and nothing is rewritten", () => {
  const tenant = randomUUID();
  const actor = randomUUID();
  const rows = { withBranch: randomUUID(), withoutBranch: randomUUID() };
  let branch = "";

  beforeAll(async () => {
    await query(`DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`, [], serverUrl);
    await query(`CREATE DATABASE ${DATABASE}`, [], serverUrl);
    deploy();
    await reverse();
    await query(`
      INSERT INTO users (id, phone_e164, password_hash, full_name, status, updated_at) VALUES ('${actor}', '+201009998866', 'x', 'Owner', 'ACTIVE', now());
      INSERT INTO tenants (id, name, slug, phone, address, locale, currency, status, settings, updated_at, country) VALUES ('${tenant}', 'Clinic', 'audit-${tenant}', '+201000000001', 'Cairo', 'ar', 'EGP', 'ACTIVE', '{}', now(), 'EG');`);
    branch = (await query<{ id: string }>("SELECT id FROM branches WHERE tenant_id = $1 AND is_default", [tenant]))[0]!.id;
    await query(`
      INSERT INTO audit_logs (id, tenant_id, actor_user_id, actor_role, action, entity_type, entity_id, ip_address, user_agent, branch_id) VALUES
        ('${rows.withBranch}',    '${tenant}', '${actor}', 'OWNER', 'CREATE', 'appointments', '${randomUUID()}', 'x', 'x', '${branch}'),
        ('${rows.withoutBranch}', '${tenant}', '${actor}', 'OWNER', 'CREATE', 'patients',     '${randomUUID()}', 'x', 'x', NULL);`);
    deploy();
  }, 240_000);

  afterAll(async () => {
    await query(`DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`, [], serverUrl);
  });

  test("a recorded branch is ONE_BRANCH; a row that recorded none is BEFORE_BRANCHES, not a guess", async () => {
    const stored = await query<{ id: string; scope: string; branch_id: string | null }>(
      "SELECT id, scope::text AS scope, branch_id FROM audit_logs WHERE id = ANY($1)", [[rows.withBranch, rows.withoutBranch]]);
    const byId = Object.fromEntries(stored.map((r) => [r.id, { scope: r.scope, branch: r.branch_id }]));
    expect(byId[rows.withBranch]).toEqual({ scope: "ONE_BRANCH", branch });
    expect(byId[rows.withoutBranch]).toEqual({ scope: "BEFORE_BRANCHES", branch: null });
  });

  test("the append-only trigger stayed on throughout, and still refuses an UPDATE", async () => {
    expect(await query("SELECT tgenabled FROM pg_trigger WHERE tgname = 'audit_logs_append_only'")).toEqual([{ tgenabled: "O" }]);
    await expect(query("UPDATE audit_logs SET scope = 'UNSCOPED' WHERE id = $1", [rows.withoutBranch])).rejects.toThrow("append-only");
  });

  test("down succeeds while every scope is derived, and refuses once one row recorded UNSCOPED", async () => {
    const hasScope = async () =>
      (await query("SELECT 1 FROM information_schema.columns WHERE table_name = 'audit_logs' AND column_name = 'scope'")).length === 1;
    await reverse();
    expect(await hasScope()).toBe(false);
    deploy();

    await query(
      `INSERT INTO audit_logs (id, tenant_id, actor_user_id, actor_role, action, entity_type, entity_id, ip_address, user_agent, scope)
       VALUES ($1, $2, $3, 'OWNER', 'UPDATE', 'patients', $4, 'x', 'x', 'UNSCOPED')`,
      [randomUUID(), tenant, actor, randomUUID()]);
    await expect(reverse()).rejects.toThrow("an UNSCOPED row exists");
    expect(await hasScope()).toBe(true);
  }, 240_000);
});
