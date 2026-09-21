import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { verifyCredentials } from "../../src/modules/auth/user-lookup.ts";
import { systemActor } from "../../src/modules/audit/system-actor.ts";
import { prisma } from "../../src/prisma/client.ts";
import { injected } from "../../src/prisma/injected.ts";
import { withTenant } from "../../src/prisma/with-tenant.ts";
import { actorFor, type ClinicFixture, seedClinic, teardownClinic } from "./fixtures.ts";
import { generateFixturePhone } from "../fixture-phone.ts";

/**
 * SCHEMA-DECISIONS.md D16: audit is a database guarantee, not an application convention.
 *
 * The load-bearing test in this file is "a raw SQL UPDATE issued outside the application still
 * produces an audit row". Everything else here is detail; that one is the claim. An interceptor
 * could pass every other test in this file and still fail that one, which is exactly why the
 * interceptor's write path was replaced.
 */

interface AuditRow {
  id: string;
  tenant_id: string | null;
  actor_user_id: string;
  actor_role: string;
  action: string;
  entity_type: string;
  entity_id: string;
  previous_state: Record<string, unknown> | null;
  new_state: Record<string, unknown> | null;
  ip_address: string;
  user_agent: string;
}

/**
 * Reads inside a bound tenant session. audit_logs carries RLS as of D17, so a read with no
 * `app.current_tenant_id` bound now returns zero rows rather than everything -- which is the
 * point of that entry, and which would otherwise make every assertion in this file silently
 * vacuous.
 */
async function auditRowsFor(tenantId: string, actorUserId: string, entityId: string): Promise<AuditRow[]> {
  return withTenant(
    tenantId,
    actorFor(actorUserId),
    async (tx) => tx.$queryRaw<AuditRow[]>`
      SELECT id, tenant_id, actor_user_id, actor_role, action, entity_type, entity_id,
             previous_state, new_state, ip_address, user_agent
      FROM audit_logs
      WHERE entity_id = ${entityId}::uuid
      ORDER BY created_at, id
    `,
  );
}

describe("audit triggers", () => {
  let fixture: ClinicFixture;

  beforeAll(async () => {
    fixture = await seedClinic();
  });

  afterAll(async () => {
    await teardownClinic(fixture);
    await prisma.$disconnect();
  });

  /**
   * The point of D16, stated as a test. This deliberately uses a bare `pg` Client and hand-written
   * SQL: no Prisma, no tenant-scoping extension, no withTenant(), no Nest request pipeline, no
   * interceptor. It is the closest thing this suite can get to "someone ran psql against
   * production", which is precisely the case an application-layer audit trail cannot cover.
   */
  test("a raw SQL UPDATE issued outside the application still produces an audit row", async () => {
    const appDatabaseUrl = process.env["APP_DATABASE_URL"];
    if (!appDatabaseUrl) throw new Error("APP_DATABASE_URL must be set (see setup-env.ts)");

    const client = new Client({ connectionString: appDatabaseUrl });
    await client.connect();

    try {
      await client.query("BEGIN");
      // Bound by hand, as any external process would have to: RLS needs the tenant, and the audit
      // trigger needs the actor. Nothing else about this connection knows the application exists.
      await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [fixture.tenantId]);
      await client.query("SELECT set_config('app.current_actor_id', $1, true)", [fixture.userId]);

      const result = await client.query("UPDATE patients SET full_name_ar = $1 WHERE id = $2", [
        "Renamed By Raw SQL",
        fixture.patientId,
      ]);
      expect(result.rowCount).toBe(1);
      await client.query("COMMIT");
    } finally {
      await client.end();
    }

    const rows = await auditRowsFor(fixture.tenantId, fixture.userId, fixture.patientId);
    const update = rows.find((row) => row.action === "UPDATE");

    expect(update).toBeDefined();
    expect(update?.entity_type).toBe("patients");
    expect(update?.tenant_id).toBe(fixture.tenantId);
    expect(update?.actor_user_id).toBe(fixture.userId);
    // to_jsonb(OLD)/to_jsonb(NEW) -- the rows Postgres actually committed, not what a service
    // claimed it was about to do.
    expect(update?.previous_state?.["full_name_ar"]).toBe("Test Patient");
    expect(update?.new_state?.["full_name_ar"]).toBe("Renamed By Raw SQL");
    // No HTTP request behind this write, so no IP or User-Agent to record. 'unknown' is the
    // honest value and is itself the signal that this did not come through the API.
    expect(update?.ip_address).toBe("unknown");
    expect(update?.user_agent).toBe("unknown");
  });

  test("a write with no actor bound is refused, not silently attributed", async () => {
    const appDatabaseUrl = process.env["APP_DATABASE_URL"];
    if (!appDatabaseUrl) throw new Error("APP_DATABASE_URL must be set (see setup-env.ts)");

    const client = new Client({ connectionString: appDatabaseUrl });
    await client.connect();

    try {
      await client.query("BEGIN");
      // Tenant bound, actor deliberately not -- the shape of a caller that got RLS right and
      // attribution wrong. D16: this raises rather than defaulting to anything.
      await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [fixture.tenantId]);

      await expect(
        client.query("UPDATE patients SET full_name_ar = $1 WHERE id = $2", ["Anonymous", fixture.patientId]),
      ).rejects.toThrow(/no actor bound/i);

      await client.query("ROLLBACK");
    } finally {
      await client.end();
    }
  });

  test("an INSERT through the application records CREATE with the committed row as new_state", async () => {
    const patientId = randomUUID();

    await withTenant(fixture.tenantId, actorFor(fixture.userId), async (tx) => {
      await tx.patient.create({
        data: injected({
          id: patientId,
          fullNameAr: "Audited On Create",
          phoneE164: generateFixturePhone(),
          relationshipToContact: "SELF",
          status: "ACTIVE",
        }),
      });
    });

    const rows = await auditRowsFor(fixture.tenantId, fixture.userId, patientId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.action).toBe("CREATE");
    expect(rows[0]?.entity_type).toBe("patients");
    expect(rows[0]?.previous_state).toBeNull();
    expect(rows[0]?.new_state?.["full_name_ar"]).toBe("Audited On Create");
    // Bound by withTenant() from the ActorContext, which is where HTTP-layer facts enter Postgres.
    expect(rows[0]?.ip_address).toBe("127.0.0.1");
    expect(rows[0]?.user_agent).toBe("jest-integration-tests");
  });

  test("a DELETE records the row that was removed", async () => {
    const patientId = randomUUID();

    await withTenant(fixture.tenantId, actorFor(fixture.userId), async (tx) => {
      await tx.patient.create({
        data: injected({
          id: patientId,
          fullNameAr: "Audited On Delete",
          phoneE164: generateFixturePhone(),
          relationshipToContact: "SELF",
          status: "ACTIVE",
        }),
      });
      await tx.patient.delete({ where: { id: patientId } });
    });

    const rows = await auditRowsFor(fixture.tenantId, fixture.userId, patientId);
    expect(rows.map((row) => row.action)).toEqual(["CREATE", "DELETE"]);
    expect(rows[1]?.previous_state?.["full_name_ar"]).toBe("Audited On Delete");
    expect(rows[1]?.new_state).toBeNull();
  });

  test("actor_role is looked up from memberships, not taken from the caller", async () => {
    const rows = await auditRowsFor(fixture.tenantId, fixture.userId, fixture.patientId);
    // seedClinic() gives its user a DOCTOR membership; nothing in the write path ever told the
    // trigger that. It read it from the memberships table.
    expect(rows[0]?.actor_role).toBe("DOCTOR");
  });

  test("audit_logs ids are UUIDv7, like every other id in the schema", async () => {
    const rows = await auditRowsFor(fixture.tenantId, fixture.userId, fixture.patientId);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      // Version nibble and variant bits, per RFC 9562 -- a v4 id would show '4' and this would
      // silently pass if uuid_generate_v7() were ever swapped for gen_random_uuid().
      expect(row.id[14]).toBe("7");
      expect(["8", "9", "a", "b"]).toContain(row.id[19]);
    }
  });

  describe("the system actor", () => {
    test("writes are attributed to it with actor_role SYSTEM", async () => {
      const patientId = randomUUID();
      const actor = await systemActor();

      await withTenant(fixture.tenantId, actor, async (tx) => {
        await tx.patient.create({
          data: injected({
            id: patientId,
            fullNameAr: "Written By The Nightly Job",
            phoneE164: generateFixturePhone(),
            relationshipToContact: "SELF",
            status: "ACTIVE",
          }),
        });
      });

      const rows = await auditRowsFor(fixture.tenantId, fixture.userId, patientId);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.actor_user_id).toBe(actor.userId);
      // It has no membership in this or any tenant and never will -- 'SYSTEM', not 'UNKNOWN',
      // marks that as deliberate rather than as an anomaly worth investigating.
      expect(rows[0]?.actor_role).toBe("SYSTEM");
    });

    test("cannot be authenticated as, by any password", async () => {
      const actor = await systemActor();
      const row = await prisma.user.findUniqueOrThrow({ where: { id: actor.userId } });

      // Two independent barriers, asserted separately: either alone would be sufficient, and a
      // test that only checked the outcome would not notice one of them being removed.
      expect(row.status).toBe("LOCKED");
      expect(row.passwordHash).not.toMatch(/^\$argon2/);

      for (const candidate of ["", "password", "no-login:system-actor", row.passwordHash]) {
        await expect(verifyCredentials(row.phoneE164, candidate)).resolves.toBeNull();
      }
    });
  });

  test("every tenant-scoped table carries the audit trigger", async () => {
    // Structural, not behavioural: this is the test that fails when someone adds a table to
    // schema.prisma and tenant-scoped-models.ts but forgets 07-audit-triggers.sql's list. The
    // expected set is derived from the triggers RLS covers, so the two lists cannot silently
    // diverge from each other either.
    const rows = await prisma.$queryRaw<{ table_name: string }[]>`
      SELECT c.relname AS table_name
      FROM pg_class c
      WHERE c.relrowsecurity
        AND c.relnamespace = 'public'::regnamespace
        -- audit_logs carries RLS as of D17 but deliberately has no audit trigger: a table that
        -- audited itself would recurse, and it is append-only, so the only operation there is to
        -- audit is the INSERT the trigger would have been making.
        AND c.relname <> 'audit_logs'
        -- notification_reads carries RLS but is deliberately NOT audited (PHASE-2.md §16 and
        -- prisma/sql/17-notifications.sql). Marking something read is a write, and D16 audits
        -- every write without degrading -- so opening the bell would insert an audit row per
        -- notification per glance, and a receptionist opening it twenty times a day would generate
        -- more audit traffic than the clinic's clinical work, burying the trail this project keeps
        -- precisely so it can be read. Same reasoning as audit_logs itself: this table records that
        -- someone LOOKED, not that anything changed.
        AND c.relname <> 'notification_reads'
        AND NOT EXISTS (
          SELECT 1 FROM pg_trigger t
          WHERE t.tgrelid = c.oid AND NOT t.tgisinternal AND t.tgname = c.relname || '_audit'
        )
    `;
    expect(rows.map((row) => row.table_name)).toEqual([]);

    const counted = await prisma.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM pg_trigger
      WHERE NOT tgisinternal AND tgname LIKE '%\\_audit'
    `;
    // 35 as of 2026-09-02: 33 plus `insurance_policies` and `patient_insurance` (prisma/sql/21,
    // PHASE-3.md Q18). The founder asked specifically that an edit to a patient's contact or cover
    // be traceable, and `audit_row_change()` writes whole-row JSON on UPDATE — so a corrected
    // policy number carries both spellings, which is the point.
    //
    // 33 as of 2026-09-01: 32 plus `patient_transfers` (prisma/sql/19, SCHEMA-DECISIONS.md D24).
    // Who opened whose record under a transfer grant, and when, is the entire accountability story
    // for the first deliberate exception to the doctor-only rule, so that table is audited like any
    // other clinical one.
    //
    // 32: the 29 tenant-scoped tables, plus `tenants` (D22), plus `notifications`. Not
    // `notification_reads`, which is RLS-protected but deliberately unaudited -- see above.
    // Previously 30 since D22: the 29 tenant-scoped tables plus `tenants` itself, which gained RLS and
    // therefore -- by this test's own rule -- an audit trigger. Its trigger fires on UPDATE only,
    // because creating a clinic is structurally unbound and an actor-requiring trigger would make
    // it impossible; see prisma/sql/15-tenants-audit.sql.
    // 36 as of 2026-09-08: patient_clinical_profiles joined (PR 7b). A corrected family history
    // must leave a trace, and the trigger list is a literal array — which is how `attachments`
    // once ended up with a gap.
    // 38 as of 2026-09-08: visit_procedures joined (PR 4). A price snapshot that changed, and who
    // changed it, is exactly what an invoice dispute asks for.
    // 43 as of 2026-09-09: insurance_companies (PR 1), then visit_charges, visit_charge_lines
    // and chargeable_materials (PR 3).
    // 44 as of 2026-09-13: `users` joined, on the founder's ruling. It carries no `tenant_id` and so
    // was excluded with the other cross-tenant tables in 07 — a decision made by the mechanism
    // rather than about the content. A name, a phone number, a photo and a password reset are
    // administrative acts, and diagnosing the owner's demotion needed the date a photo was written,
    // which could only be recovered by decoding a UUIDv7 out of a storage key.
    // 45 as of 2026-09-13: `patient_credits` (ruling 5). Money that outlives the appointment it came
    // from is exactly the kind of row an audit trail is kept for.
    // 48 as of 2026-09-15: the three back-office tables. They carry RLS, so this test's own rule
    // demanded a trigger — and they could not use `audit_row_change()`, which stamps the row with
    // `NEW.tenant_id` and would have put the vendor's agreed discount and sales notes into the
    // clinic's own audit trail, readable on the screen shipped in #107.
    // `audit_platform_row_change()` writes `tenant_id = NULL` instead, which the D17 policy makes
    // visible to no tenant session at all.
    // 49 as of 2026-09-18: `bot_credentials`. Its trigger is `audit_bot_credential_change()`, which
    // redacts `secret_hash` and fires on the columns that change the credential — never on
    // `last_used_at`, or every call the bot makes would write an audit row.
    // 50 as of 2026-09-18: `webhook_deliveries`. Its trigger fires only when a delivery is given up
    // on — an audit row per retry would bury the clinic history under our retry schedule.
    expect(Number(counted[0]?.n)).toBe(50);
  });

  /**
   * **`users` is audited, and the sweep counts it among the covered tables** — the founder's ruling
   * of 2026-09-13, asserted by name rather than left to the count above.
   *
   * The structural sweep derives its expectation from RLS, and `users` has none: a person is not
   * owned by a clinic. So nothing in that query would ever have demanded this trigger, which is
   * precisely why it is named here.
   */
  test("users is among the audited tables, by name", async () => {
    const rows = await prisma.$queryRaw<{ tgname: string }[]>`
      SELECT tgname FROM pg_trigger
      WHERE NOT tgisinternal AND tgrelid = 'users'::regclass AND tgname = 'users_audit'
    `;
    expect(rows.map((row) => row.tgname)).toEqual(["users_audit"]);
  });
});
