import "dotenv/config";
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { compareMigrations, driftMessage } from "../migration-drift.ts";

/**
 * Runs once before the integration suite starts (Jest `globalSetup`, not `setupFiles` -- this is
 * a one-time side effect against the database, not a per-worker environment tweak). Makes
 * `npm run test:integration` self-sufficient after a fresh `docker compose up`: it applies the
 * same migrations clinic_os_dev gets to clinic_os_test, then sets clinic_os_app's password to
 * match TEST_APP_DATABASE_URL -- the app_role migration creates that role with no password by
 * design (SCHEMA-DECISIONS.md D12/D13: no secret in a checked-in migration file), so a freshly
 * migrated test database is otherwise unusable until something sets one.
 */
/**
 * Refuses to run against a database holding migrations this branch does not have.
 *
 * Checked before `migrate deploy`, because deploy moves only forward and cannot repair this: the
 * schema keeps columns the branch's code knows nothing about, and the suite fails somewhere else
 * entirely. On 2026-09-16 that cost two debugging detours, both looking like code defects.
 */
async function assertNoMigrationDrift(testDatabaseUrl: string, apiRoot: string): Promise<void> {
  const onDisk = readdirSync(path.join(apiRoot, "prisma", "migrations"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

  const client = new Client({ connectionString: testDatabaseUrl });
  await client.connect();
  let applied: string[];
  try {
    const rows = await client.query<{ migration_name: string }>(
      "SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL",
    );
    applied = rows.rows.map((row) => row.migration_name);
  } catch {
    // No `_prisma_migrations` table: a fresh database with nothing applied, which cannot have drifted.
    return;
  } finally {
    await client.end();
  }

  const { ahead } = compareMigrations(applied, onDisk);
  if (ahead.length > 0) {
    throw new Error(driftMessage(new URL(testDatabaseUrl).pathname.replace(/^\//, ""), ahead));
  }
}

export default async function globalSetup(): Promise<void> {
  const testDatabaseUrl = process.env["TEST_DATABASE_URL"];
  const testAppDatabaseUrl = process.env["TEST_APP_DATABASE_URL"];
  if (!testDatabaseUrl || !testAppDatabaseUrl) {
    throw new Error(
      "TEST_DATABASE_URL and TEST_APP_DATABASE_URL must both be set (see apps/api/.env.example) " +
        "to run the integration suite.",
    );
  }

  const apiRoot = path.resolve(__dirname, "..", "..");
  await assertNoMigrationDrift(testDatabaseUrl, apiRoot);

  // Run Prisma's CLI entry point with this same Node binary, rather than going through `npx`.
  // `npx` is `npx.cmd` on Windows, which is only executable via a shell, and `shell: true`
  // concatenates arguments instead of escaping them -- Node 26 deprecates that combination
  // (DEP0190). Resolving the CLI's JS entry needs no shell on any platform, which also removes
  // the POSIX-vs-Windows difference flagged in docs/SETUP.md §11.
  const prismaCli = require.resolve("prisma/build/index.js");
  execFileSync(process.execPath, [prismaCli, "migrate", "deploy"], {
    cwd: apiRoot,
    env: { ...process.env, DATABASE_URL: testDatabaseUrl },
    stdio: "inherit",
  });

  const appPassword = new URL(testAppDatabaseUrl).password;
  const superuser = new Client({ connectionString: testDatabaseUrl });
  await superuser.connect();
  try {
    await superuser.query(`ALTER ROLE clinic_os_app WITH PASSWORD '${appPassword.replace(/'/g, "''")}'`);
  } finally {
    await superuser.end();
  }
}
