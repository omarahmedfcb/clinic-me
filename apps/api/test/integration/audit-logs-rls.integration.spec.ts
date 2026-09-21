import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { prisma } from "../../src/prisma/client.ts";
import { injected } from "../../src/prisma/injected.ts";
import { withTenant } from "../../src/prisma/with-tenant.ts";
import {
  actorFor,
  type ClinicFixture,
  createTestTenant,
  createTestUser,
  seedClinic,
  teardownClinic,
} from "./fixtures.ts";
import { generateFixturePhone } from "../fixture-phone.ts";

/**
 * SCHEMA-DECISIONS.md D17: RLS on audit_logs.
 *
 * D16 made audit_logs a full copy of every row of all 29 protected tables, while D15 had left it
 * as the one tenant-carrying table with no policy on it. This file covers closing that.
 *
 * The first test is the one that matters most, and it is a test of the fix not breaking the
 * product rather than of the fix working: audit_row_change() is SECURITY INVOKER, so it runs as
 * clinic_os_app, which is NOBYPASSRLS. A policy whose WITH CHECK rejected the trigger's own
 * INSERT would not fail visibly on audit_logs -- it would fail on every mutation in the entire
 * product, because the trigger is part of the writing statement.
 */

function observerUrl(): string {
  // A connection that sees rows the policy hides, used only to observe them -- a test that checked
  // invisibility from a connection that cannot see them either would prove nothing.
  //
  // TEST_OBSERVER_URL when the drill sets one: `scripts/rls-ownership-drill.mjs` runs this suite
  // against a database with no superuser, where the migration role is subject to its own policies.
  // Observing is the test harness's problem, not the product's, so the drill supplies a role for it
  // rather than the product relying on a superuser existing.
  const url = process.env["TEST_OBSERVER_URL"] ?? process.env["DATABASE_URL"];
  if (!url) throw new Error("DATABASE_URL must be set (see setup-env.ts)");
  return url;
}

function appUrl(): string {
  const url = process.env["APP_DATABASE_URL"];
  if (!url) throw new Error("APP_DATABASE_URL must be set (see setup-env.ts)");
  return url;
}

async function asObserver<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: observerUrl() });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

describe("audit_logs row-level security", () => {
  let clinicA: ClinicFixture;
  let clinicB: ClinicFixture;
  let platformAdminId: string;
  let orphanRowId: string;

  beforeAll(async () => {
    clinicA = await seedClinic();
    clinicB = await seedClinic();

    platformAdminId = randomUUID();
    await prisma.user.create({
      data: {
        id: platformAdminId,
        phoneE164: generateFixturePhone(),
        passwordHash: "test-hash-not-real",
        fullName: "Platform Admin",
        isPlatformAdmin: true,
        // A CHECK refuses the flag without a seat, from 2026-09-15.
        platformRole: "OWNER",
        status: "ACTIVE",
      },
    });

    // A row belonging to no tenant. Since D18 this state is not produced by deleting a tenant --
    // that is now blocked outright, and the FK action that would have produced it could never
    // have fired anyway. It is reached by platform-level events (the BREAK_GLASS_ACCESS rows
    // further down are the live example) and by whatever anonymisation process D14 calls for.
    // Inserted through the observer connection, standing in for such a row, because the policy
    // correctly makes it unwritable by any ordinary session -- which is itself asserted below.
    orphanRowId = randomUUID();
    await asObserver(async (client) => {
      await client.query(
        `INSERT INTO audit_logs (id, tenant_id, actor_user_id, actor_role, action, entity_type,
                                 entity_id, previous_state, new_state, ip_address, user_agent, created_at)
         VALUES ($1, NULL, $2, 'ADMIN', 'DELETE', 'patients', $3, '{"full_name_ar":"Closed Clinic Patient"}'::jsonb,
                 NULL, 'unknown', 'unknown', now())`,
        [orphanRowId, clinicA.userId, randomUUID()],
      );
    });
  });

  afterAll(async () => {
    await asObserver(async (client) => {
      // audit_logs is append-only (D5) for every role including this one, so the rows this file
      // created stay. Harmless and confined to the disposable test database -- the same
      // best-effort cleanup posture fixtures.ts documents.
      await client.query("DELETE FROM users WHERE id = $1", [platformAdminId]).catch(() => undefined);
    });
    await teardownClinic(clinicA);
    await teardownClinic(clinicB);
    await prisma.$disconnect();
  });

  /**
   * The failure mode worth testing before anything else. If this breaks, nothing in the product
   * can write at all.
   */
  test("the audit trigger can still write while RLS is enforced on audit_logs", async () => {
    const patientId = randomUUID();

    await withTenant(clinicA.tenantId, actorFor(clinicA.userId), async (tx) => {
      await tx.patient.create({
        data: injected({
          id: patientId,
          fullNameAr: "Written Under RLS",
          phoneE164: generateFixturePhone(),
          relationshipToContact: "SELF",
          status: "ACTIVE",
        }),
      });
    });

    // Observed from outside RLS, so this asserts the row was really committed rather than merely
    // being visible to the session that wrote it.
    const rows = await asObserver(async (client) =>
      client.query("SELECT tenant_id, action FROM audit_logs WHERE entity_id = $1::uuid", [patientId]),
    );

    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0].tenant_id).toBe(clinicA.tenantId);
    expect(rows.rows[0].action).toBe("CREATE");
  });

  test("a session bound to tenant A cannot read tenant B's audit rows", async () => {
    // Both clinics have audit history: seedClinic() writes a membership, doctor, service and
    // patient through withTenant(), every one of which fired the trigger.
    const totalForB = await asObserver(async (client) =>
      client.query("SELECT count(*)::int AS n FROM audit_logs WHERE tenant_id = $1::uuid", [clinicB.tenantId]),
    );
    expect(totalForB.rows[0].n).toBeGreaterThan(0);

    const seenFromA = await withTenant(
      clinicA.tenantId,
      actorFor(clinicA.userId),
      async (tx) => tx.$queryRaw<{ n: bigint }[]>`
        SELECT count(*) AS n FROM audit_logs WHERE tenant_id = ${clinicB.tenantId}::uuid
      `,
    );
    expect(Number(seenFromA[0]?.n)).toBe(0);

    // And the same session does see its own -- otherwise this test would pass against a policy
    // that simply hid everything.
    const ownRows = await withTenant(
      clinicA.tenantId,
      actorFor(clinicA.userId),
      async (tx) => tx.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM audit_logs`,
    );
    expect(Number(ownRows[0]?.n)).toBeGreaterThan(0);
  });

  test("orphaned rows are visible to no tenant session, and to no unbound session", async () => {
    const fromTenant = await withTenant(
      clinicA.tenantId,
      actorFor(clinicA.userId),
      async (tx) => tx.$queryRaw<{ n: bigint }[]>`
        SELECT count(*) AS n FROM audit_logs WHERE id = ${orphanRowId}::uuid
      `,
    );
    expect(Number(fromTenant[0]?.n)).toBe(0);

    // No tenant bound at all: NULLIF(...) is NULL, and `tenant_id = NULL` is never true, so this
    // fails closed rather than falling open.
    const unbound = await prisma.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM audit_logs WHERE id = ${orphanRowId}::uuid
    `;
    expect(Number(unbound[0]?.n)).toBe(0);

    // The row does exist -- the two assertions above are about visibility, not absence.
    const actual = await asObserver(async (client) =>
      client.query("SELECT count(*)::int AS n FROM audit_logs WHERE id = $1::uuid", [orphanRowId]),
    );
    expect(actual.rows[0].n).toBe(1);
  });

  describe("break-glass access to orphaned rows", () => {
    async function callAsActor(actorUserId: string | null): Promise<Client> {
      const client = new Client({ connectionString: appUrl() });
      await client.connect();
      await client.query("BEGIN");
      if (actorUserId) {
        await client.query("SELECT set_config('app.current_actor_id', $1, true)", [actorUserId]);
      }
      return client;
    }

    test("refuses a caller who is not a platform admin", async () => {
      const client = await callAsActor(clinicA.userId);
      try {
        await expect(client.query("SELECT * FROM read_orphaned_audit_logs(10)")).rejects.toThrow(
          /not an active platform admin/i,
        );
      } finally {
        await client.query("ROLLBACK").catch(() => undefined);
        await client.end();
      }
    });

    test("refuses a caller with no actor bound", async () => {
      const client = await callAsActor(null);
      try {
        await expect(client.query("SELECT * FROM read_orphaned_audit_logs(10)")).rejects.toThrow(
          /requires a bound actor/i,
        );
      } finally {
        await client.query("ROLLBACK").catch(() => undefined);
        await client.end();
      }
    });

    test("returns orphaned rows to a platform admin, and records the read as break-glass", async () => {
      const client = await callAsActor(platformAdminId);
      let returned;
      try {
        returned = await client.query("SELECT * FROM read_orphaned_audit_logs(10)");
        await client.query("COMMIT");
      } finally {
        await client.end();
      }

      expect(returned.rows.map((row: { id: string }) => row.id)).toContain(orphanRowId);
      expect(returned.rows[0].new_state ?? returned.rows.find((r: { id: string }) => r.id === orphanRowId)).toBeTruthy();

      // The disclosure is itself in the record. Read as the superuser because the row it wrote is
      // NULL-tenant, and therefore invisible to every ordinary session by the same policy that
      // made the break-glass path necessary in the first place.
      const events = await asObserver(async (client2) =>
        client2.query(
          `SELECT actor_user_id, actor_role, action, entity_type, new_state
           FROM audit_logs
           WHERE action = 'BREAK_GLASS_ACCESS' AND actor_user_id = $1::uuid`,
          [platformAdminId],
        ),
      );

      expect(events.rowCount).toBe(1);
      expect(events.rows[0].actor_role).toBe("PLATFORM_ADMIN");
      expect(events.rows[0].entity_type).toBe("audit_logs");
      expect(events.rows[0].new_state).toEqual({ scope: "orphaned_audit_logs", limit: 10 });
    });
  });

  /**
   * SCHEMA-DECISIONS.md D18. audit_logs.tenant_id used to carry ON DELETE SET NULL -- Prisma's
   * default for an optional relation, never a decision -- and setting it to NULL is an UPDATE,
   * which the D5 append-only trigger refuses unconditionally. Deleting a tenant therefore failed
   * with a bare "Table audit_logs is append-only", with no constraint and no table attached,
   * which tells whoever ran it nothing about what they actually did wrong.
   */
  describe("deleting a tenant that has audit history", () => {
    test("fails as a foreign-key violation naming the constraint, not as an append-only error", async () => {
      // A tenant whose scoped tables are all empty but whose audit history is not -- a clinic
      // that registered a patient and later deleted them. Audit rows survive the rows they
      // describe, so the 29 RESTRICT foreign keys have nothing left to block on and audit_logs'
      // is the one the delete actually reaches. Built from scratch rather than reusing a
      // seedClinic() fixture, which deliberately leaves a membership, doctor and service behind;
      // those block first, on their own foreign keys, and would hide the case under test.
      const tenantId = await createTestTenant();
      const userId = await createTestUser();
      const patientId = randomUUID();

      await withTenant(tenantId, actorFor(userId), async (tx) => {
        await tx.patient.create({
          data: injected({
            id: patientId,
            fullNameAr: "Registered Then Removed",
            phoneE164: generateFixturePhone(),
            relationshipToContact: "SELF",
            status: "ACTIVE",
          }),
        });
        await tx.patient.delete({ where: { id: patientId } });
      });

      const remaining = await asObserver(async (client) =>
        client.query("SELECT count(*)::int AS n FROM patients WHERE tenant_id = $1::uuid", [tenantId]),
      );
      const audited = await asObserver(async (client) =>
        client.query("SELECT count(*)::int AS n FROM audit_logs WHERE tenant_id = $1::uuid", [tenantId]),
      );
      expect(remaining.rows[0].n).toBe(0);
      expect(audited.rows[0].n).toBeGreaterThan(0);

      const failure = await asObserver(async (client) =>
        client
          .query("DELETE FROM tenants WHERE id = $1", [tenantId])
          .then(() => null)
          .catch((err: { code?: string; constraint?: string; message: string }) => err),
      );

      expect(failure).not.toBeNull();
      // 23503 is foreign_key_violation. The old behaviour was P0001 (raise_exception) from
      // forbid_mutation(), and asserting the code rather than just "it threw" is what keeps this
      // from passing again if the SET NULL action ever comes back.
      expect(failure?.code).toBe("23503");
      expect(failure?.constraint).toBe("audit_logs_tenant_id_fkey");
      expect(failure?.message).not.toMatch(/append-only/i);
    });
  });

  test("audit_logs has RLS enabled and forced, and is still append-only", async () => {
    const flags = await prisma.$queryRaw<{ enabled: boolean; forced: boolean }[]>`
      SELECT relrowsecurity AS enabled, relforcerowsecurity AS forced
      FROM pg_class WHERE oid = 'audit_logs'::regclass
    `;
    // FORCE matters specifically here: without it the table owner -- the role migrations run as --
    // is exempt, and D5's own reasoning about who eventually reads this table applies.
    expect(flags[0]).toEqual({ enabled: true, forced: true });

    const triggers = await prisma.$queryRaw<{ tgname: string }[]>`
      SELECT tgname FROM pg_trigger
      WHERE tgrelid = 'audit_logs'::regclass AND NOT tgisinternal
    `;
    expect(triggers.map((t) => t.tgname)).toContain("audit_logs_append_only");
  });
});
