import { Client } from "pg";
import { prisma } from "../../src/prisma/client.ts";

/**
 * Ports the two Phase 1 DoD connection-security assertions (docs/PHASE-1.md) into the repo:
 * the runtime role must not be a superuser and must not bypass RLS (SCHEMA-DECISIONS.md D12), and
 * a wrong password must actually be rejected, not silently accepted via a leftover `trust` rule
 * (D13 -- this is the regression that motivated enforcing scram-sha-256 for loopback).
 */
describe("connection security", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  test("the runtime connection role is not a superuser and does not bypass RLS", async () => {
    const rows = await prisma.$queryRaw<{ rolname: string; rolsuper: boolean; rolbypassrls: boolean }[]>`
      SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.rolname).toBe("clinic_os_app");
    expect(rows[0]?.rolsuper).toBe(false);
    expect(rows[0]?.rolbypassrls).toBe(false);
  });

  test("a deliberately wrong password is rejected", async () => {
    const appDatabaseUrl = process.env["APP_DATABASE_URL"];
    if (!appDatabaseUrl) throw new Error("APP_DATABASE_URL must be set (see setup-env.ts)");

    const wrongUrl = appDatabaseUrl.replace(/:\/\/([^:]+):([^@]+)@/, "://$1:definitely-the-wrong-password@");
    const client = new Client({ connectionString: wrongUrl });

    await expect(client.connect()).rejects.toThrow(/password authentication failed/i);

    // client.connect() having thrown, the client is not connected -- nothing to end().
  });
});
