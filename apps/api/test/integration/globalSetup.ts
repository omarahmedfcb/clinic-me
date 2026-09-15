import "dotenv/config";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { Client } from "pg";

/**
 * Runs once before the integration suite starts (Jest `globalSetup`, not `setupFiles` -- this is
 * a one-time side effect against the database, not a per-worker environment tweak). Makes
 * `npm run test:integration` self-sufficient after a fresh `docker compose up`: it applies the
 * same migrations clinic_os_dev gets to clinic_os_test, then sets clinic_os_app's password to
 * match TEST_APP_DATABASE_URL -- the app_role migration creates that role with no password by
 * design (SCHEMA-DECISIONS.md D12/D13: no secret in a checked-in migration file), so a freshly
 * migrated test database is otherwise unusable until something sets one.
 */
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
