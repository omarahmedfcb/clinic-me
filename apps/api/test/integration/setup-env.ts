import "dotenv/config";

const testDatabaseUrl = process.env["TEST_DATABASE_URL"];
const testAppDatabaseUrl = process.env["TEST_APP_DATABASE_URL"];

if (!testDatabaseUrl || !testAppDatabaseUrl) {
  throw new Error(
    "TEST_DATABASE_URL and TEST_APP_DATABASE_URL must both be set (see apps/api/.env.example) " +
      "to run the integration suite. It must never fall back to running against " +
      "DATABASE_URL/APP_DATABASE_URL -- that is the dev database, and SCHEMA-DECISIONS.md's " +
      "dedicated-test-database decision exists specifically so a test run can never touch it.",
  );
}

// apps/api/src/prisma/client.ts reads DATABASE_URL/APP_DATABASE_URL at module-import time, not
// lazily -- this override has to happen in a Jest `setupFiles` entry, which runs before any spec
// file's imports, not in a `beforeAll` inside a test, which would run too late. Overriding the
// env here (rather than giving the production client a test-only constructor argument) means the
// integration suite exercises the exact same client.ts / with-tenant.ts code that runs in
// production, just pointed at a different database -- the standard twelve-factor difference
// between environments, not a parallel test-only code path that could drift from the real one.
process.env["DATABASE_URL"] = testDatabaseUrl;
process.env["APP_DATABASE_URL"] = testAppDatabaseUrl;
