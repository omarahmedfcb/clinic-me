// Proves the schema works with no superuser anywhere: a database owned by a NOSUPERUSER NOBYPASSRLS
// role, migrated by it, then the whole integration suite. `node scripts/rls-ownership-drill.mjs`.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const ROOT = process.env["REPO_ROOT"] ?? path.resolve(import.meta.dirname, "..");
const API = path.join(ROOT, "apps", "api");
const require_ = createRequire(path.join(API, "package.json"));
const { Client } = require_("pg");

/**
 * The shape a managed PostgreSQL hands over: an owner that is not a superuser and cannot bypass RLS.
 *
 * `CREATEROLE` because the app-role migration creates `clinic_os_app`, which is what a provider's
 * own admin account does too. Nothing here is a superuser, which is the entire point of the drill.
 */
const DRILL_DB = "clinic_os_rls_ownership";
const OWNER = "clinic_os_drill_owner";
const OWNER_PASSWORD = "drill-only-not-a-real-password";
const APP_PASSWORD = "drill-only-app-password";
const OBSERVER = "clinic_os_drill_observer";
const OBSERVER_PASSWORD = "drill-only-observer-password";

const read = (key, env) => new RegExp(`^${key}\\s*=\\s*"?([^"\\r\\n]+)"?`, "m").exec(env)?.[1];
const swap = (url, database) => url.replace(/\/[^/?]+(\?|$)/, `/${database}$1`);
const withCredentials = (url, user, password) =>
  url.replace(/\/\/[^@]+@/, `//${user}:${encodeURIComponent(password)}@`);

// DATABASE_URL from the environment when there is one (CI has no `.env`), else apps/api/.env.
const superUrl =
  process.env["DATABASE_URL"] ??
  (existsSync(path.join(API, ".env")) ? read("DATABASE_URL", readFileSync(path.join(API, ".env"), "utf8")) : undefined);
if (superUrl === undefined) {
  console.error("Set DATABASE_URL, or put it in apps/api/.env: the drill needs a role that can create databases and roles.");
  process.exit(1);
}
const adminUrl = swap(superUrl, "postgres");
const ownerUrl = withCredentials(swap(superUrl, DRILL_DB), OWNER, OWNER_PASSWORD);
const appUrl = withCredentials(swap(superUrl, DRILL_DB), "clinic_os_app", APP_PASSWORD);
const observerUrl = withCredentials(swap(superUrl, DRILL_DB), OBSERVER, OBSERVER_PASSWORD);

async function sql(connectionString, statements) {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    for (const statement of statements) await client.query(statement);
  } finally {
    await client.end();
  }
}

async function main() {
  console.log(`  Rebuilding ${DRILL_DB}, owned by ${OWNER} (NOSUPERUSER NOBYPASSRLS).\n`);
  await sql(adminUrl, [
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${DRILL_DB}'`,
    `DROP DATABASE IF EXISTS "${DRILL_DB}"`,
    `DO $$ BEGIN
       IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${OWNER}') THEN
         CREATE ROLE ${OWNER} LOGIN PASSWORD '${OWNER_PASSWORD}' NOSUPERUSER NOBYPASSRLS CREATEROLE NOCREATEDB;
       ELSE
         ALTER ROLE ${OWNER} WITH LOGIN PASSWORD '${OWNER_PASSWORD}' NOSUPERUSER NOBYPASSRLS CREATEROLE NOCREATEDB;
       END IF;
     END $$`,
    `CREATE DATABASE "${DRILL_DB}" OWNER ${OWNER}`,
  ]);

  // Roles are cluster-wide, so clinic_os_app usually already exists here from another database. A
  // managed instance has no such history -- its admin creates the role and can therefore alter it.
  await sql(swap(superUrl, DRILL_DB), [
    `DO $$ BEGIN
       IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'clinic_os_app') THEN
         EXECUTE 'GRANT clinic_os_app TO ${OWNER} WITH ADMIN OPTION';
       END IF;
     END $$`,
  ]);

  console.log("  Migrating as the non-superuser owner.\n");
  execFileSync(process.execPath, [require_.resolve("prisma/build/index.js"), "migrate", "deploy"], {
    cwd: API,
    env: { ...process.env, DATABASE_URL: ownerUrl },
    stdio: "inherit",
  });

  const client = new Client({ connectionString: ownerUrl });
  await client.connect();
  const owners = await client.query(
    `SELECT pg_get_userbyid(p.proowner) AS owner, count(*)::int AS functions
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.prosecdef
        AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
      GROUP BY 1 ORDER BY 1`,
  );
  /**
   * Every SECURITY DEFINER function must be owned by `clinic_os_definer`, and the list comes from
   * the catalogue rather than from names typed here: a helper added later and left owned by the
   * migration role is exactly what a hand-written list misses, and it would work locally.
   */
  const strays = await client.query(
    `SELECT p.oid::regprocedure::text AS signature, pg_get_userbyid(p.proowner) AS owner,
            (SELECT rolsuper FROM pg_roles WHERE oid = p.proowner) AS owner_is_superuser
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.prosecdef
        AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
        AND pg_get_userbyid(p.proowner) <> 'clinic_os_definer'
      ORDER BY 1`,
  );
  await client.end();

  console.log(`\n  SECURITY DEFINER functions by owner: ${owners.rows.map((r) => `${r.owner}=${r.functions}`).join(", ")}`);
  if (strays.rowCount > 0) {
    console.error(`\n  REFUSED: ${strays.rowCount} SECURITY DEFINER function(s) are not owned by clinic_os_definer:`);
    for (const row of strays.rows) {
      console.error(`    ${row.signature} — owned by ${row.owner}${row.owner_is_superuser ? " (a superuser)" : ""}`);
    }
    console.error("\n  Reassign it in a migration, the way 20260918080000_definer_role_portability does.");
    console.error("  Owned by the migration role, it works locally and fails on a managed instance.");
    process.exit(1);
  }

  /**
   * The suite needs one connection that can see rows RLS hides, to check that hidden rows exist.
   *
   * That is the harness's problem, not the product's: no product code path uses this role, and it is
   * created here rather than by a migration so it cannot follow the schema to a server.
   */
  await sql(swap(superUrl, DRILL_DB), [
    `DO $$ BEGIN
       IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${OBSERVER}') THEN
         CREATE ROLE ${OBSERVER} LOGIN PASSWORD '${OBSERVER_PASSWORD}' NOSUPERUSER BYPASSRLS;
       ELSE
         ALTER ROLE ${OBSERVER} WITH LOGIN PASSWORD '${OBSERVER_PASSWORD}' NOSUPERUSER BYPASSRLS;
       END IF;
     END $$`,
    `GRANT USAGE ON SCHEMA public TO ${OBSERVER}`,
    `GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO ${OBSERVER}`,
  ]);

  console.log("\n  Running the integration suite against it.\n");
  execFileSync("npm", ["run", "test:integration"], {
    cwd: API,
    shell: true,
    stdio: "inherit",
    env: {
      ...process.env,
      TEST_DATABASE_URL: ownerUrl,
      TEST_APP_DATABASE_URL: appUrl,
      TEST_OBSERVER_URL: observerUrl,
    },
  });
  console.log(`\n  Green with no superuser in the picture. ${DRILL_DB} is left in place for inspection.`);
}

await main();
