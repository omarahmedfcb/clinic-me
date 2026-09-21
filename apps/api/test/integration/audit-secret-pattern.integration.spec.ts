import { Client } from "pg";
import { uuidv7 } from "uuidv7";
import { prisma } from "../../src/prisma/client.ts";
import { withTenant } from "../../src/prisma/with-tenant.ts";
import { actorFor, type ClinicFixture, seedClinic, teardownClinic } from "./fixtures.ts";
import { generateFixturePhone } from "../fixture-phone.ts";

/**
 * **A credential column added tomorrow is redacted today.**
 *
 * `audit_user_change()` used to name three columns, with a note saying the list was explicit so that
 * adding a secret column would be a visible edit. That argument lost to the evidence: `totp_secret`
 * arrived and was written into `audit_logs` in full for two days, because nobody adding a column
 * goes looking for a trigger that mentions three others by name.
 *
 * This spec adds a column the function has never heard of, writes a secret into it, and asserts the
 * audit row does not carry it. A test that only exercised the three known columns would pass against
 * the version of the function this replaced.
 */
const PROBE_COLUMN = "probe_secret";
const PROBE_VALUE = "not-a-real-credential-9c1f4b7e";

/** DDL needs the migration role; the suite's own client is the application role by design. */
function superuser(): Client {
  const url = process.env["TEST_DATABASE_URL"];
  if (url === undefined) throw new Error("TEST_DATABASE_URL is not set.");
  return new Client({ connectionString: url.replace("?schema=public", "") });
}

describe("the users audit trigger redacts by pattern", () => {
  let clinic: ClinicFixture;
  let userId = "";

  beforeAll(async () => {
    clinic = await seedClinic();
    const user = await prisma.user.create({
      data: {
        id: uuidv7(),
        phoneE164: generateFixturePhone(),
        passwordHash: "not-a-real-hash",
        fullName: "موظفة للتدقيق",
        status: "ACTIVE",
      },
    });
    userId = user.id;

    const admin = superuser();
    await admin.connect();
    await admin.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS ${PROBE_COLUMN} text`);
    await admin.query(`GRANT SELECT, UPDATE (${PROBE_COLUMN}) ON users TO clinic_os_app`);
    await admin.end();
  });

  afterAll(async () => {
    const admin = superuser();
    await admin.connect();
    await admin.query(`ALTER TABLE users DROP COLUMN IF EXISTS ${PROBE_COLUMN}`);
    await admin.end();
    await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
    await teardownClinic(clinic);
    await prisma.$disconnect();
  });

  test("a column the function has never heard of is still redacted", async () => {
    // Written through the same path a real update takes: inside withTenant, so an actor is bound and
    // the trigger runs exactly as it does in the product.
    await withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) => {
      await tx.$executeRawUnsafe(
        `UPDATE users SET ${PROBE_COLUMN} = $1, full_name = $2 WHERE id = $3::uuid`,
        PROBE_VALUE,
        "موظفة للتدقيق بعد التعديل",
        userId,
      );
    });

    // Read inside the tenant, because audit rows are RLS-scoped like everything else: an unbound
    // read answers nothing, which would make this test pass by finding no leak in no rows.
    const rows = await withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) =>
      tx.auditLog.findMany({
        where: { entityType: "users", entityId: userId },
        select: { previousState: true, newState: true },
      }),
    );
    expect(rows.length).toBeGreaterThan(0);

    const everything = JSON.stringify(rows);
    expect(everything).not.toContain(PROBE_VALUE);
    // Redacted, not omitted: the row still says the column changed and that it now holds something.
    expect(everything).toContain(`"${PROBE_COLUMN}":"(redacted: set)"`);
    // And the name change beside it is recorded in full, so the redaction is narrow.
    expect(everything).toContain("موظفة للتدقيق بعد التعديل");
  });

  test("the columns the old list named are still redacted, by the same rule", async () => {
    await withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) => {
      await tx.$executeRawUnsafe(
        `UPDATE users SET password_hash = $1 WHERE id = $2::uuid`,
        "$argon2id$v=19$m=19456,t=2,p=1$notarealsalt$notarealhashnotarealhashnotarealhash",
        userId,
      );
    });

    const rows = await withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) =>
      tx.auditLog.findMany({ where: { entityType: "users", entityId: userId }, select: { newState: true } }),
    );
    const everything = JSON.stringify(rows);
    expect(everything).not.toContain("$argon2id$v=19$m=19456,t=2,p=1$notarealsalt");
    expect(everything).toContain('"password_hash":"(redacted');
  });
});
