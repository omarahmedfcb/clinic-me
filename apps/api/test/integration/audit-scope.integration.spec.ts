// An audit row's reach (ruled 2026-10-29): the six child tables take their parent's branch, a row
// with no branch is UNSCOPED, BEFORE_BRANCHES is never written, and the sensitive read agrees.
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { ALL_BRANCHES } from "../../src/common/branch-scope.ts";
import { branchContext, type BranchContext } from "../../src/common/branch-context.ts";
import { recordSensitiveRead, type AccessContext } from "../../src/modules/clinical/clinical.access.ts";
import { prisma } from "../../src/prisma/client.ts";
import { withTenant } from "../../src/prisma/with-tenant.ts";
import { actorFor, seedClinic, teardownClinic, type ClinicFixture } from "./fixtures.ts";

// The database's own writers that name no branch, because the rows they describe have none.
const NO_BRANCH_WRITERS = [
  "audit_bot_credential_change",
  "audit_outbound_message_failure",
  "audit_platform_row_change",
  "audit_tenant_change",
  "audit_user_change",
  "audit_visit_document_link",
  "audit_webhook_failure",
  "audit_whatsapp_connection_change",
  "record_platform_audit",
];

const ownerUrl = (): string => process.env["TEST_OBSERVER_URL"] ?? process.env["DATABASE_URL"] ?? "";

describe("audit scope", () => {
  let clinic: ClinicFixture;
  let client: Client;

  beforeAll(async () => {
    clinic = await seedClinic();
    client = new Client({ connectionString: ownerUrl() });
    await client.connect();
  });

  afterAll(async () => {
    await client.end();
    await teardownClinic(clinic);
    await prisma.$disconnect();
  });

  // Everything below runs in a transaction that is rolled back: a rollback is not a DELETE, so no
  // append-only row is left behind in clinic_os_test.
  async function rolledBack<T>(work: () => Promise<T>): Promise<T> {
    await client.query("BEGIN");
    try {
      await client.query(
        `SELECT set_config('app.current_tenant_id', $1, true), set_config('app.current_actor_id', $2, true),
                set_config('app.current_branch_id', '', true)`,
        [clinic.tenantId, clinic.userId],
      );
      return await work();
    } finally {
      await client.query("ROLLBACK");
    }
  }

  const refusal = async (sql: string, params: unknown[]): Promise<string> => {
    await client.query("SAVEPOINT probe");
    try {
      await client.query(sql, params);
      return "no error";
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    } finally {
      await client.query("ROLLBACK TO SAVEPOINT probe");
    }
  };

  test("each of the six child tables takes its parent's branch, with no branch on the request", async () => {
    const reaches = await rolledBack(async () => {
      const b = randomUUID();
      const ids = { template: randomUUID(), brk: randomUUID(), appt: randomUUID(), event: randomUUID(), visit: randomUUID(),
        revision: randomUUID(), procedure: randomUUID(), charge: randomUUID(), line: randomUUID(), payment: randomUUID(), adjustment: randomUUID() };
      const t = clinic.tenantId;
      const u = clinic.userId;
      await client.query(
        `INSERT INTO branches (id, tenant_id, name, address, phone, receipt_prefix, invoice_prefix, updated_at)
         VALUES ($1, $2, 'Second', 'Giza', '+201000000009', 'B', 'B', now())`, [b, t]);
      await client.query(
        `INSERT INTO schedule_templates (id, tenant_id, doctor_id, weekday, start_time, end_time, valid_from, updated_at, branch_id)
         VALUES ($1, $2, $3, 1, '09:00', '13:00', '2031-01-01', now(), $4)`, [ids.template, t, clinic.doctorId, b]);
      await client.query(
        `INSERT INTO schedule_breaks (id, tenant_id, schedule_template_id, start_time, end_time, label, updated_at)
         VALUES ($1, $2, $3, '11:00', '11:15', 'tea', now())`, [ids.brk, t, ids.template]);
      await client.query(
        `INSERT INTO appointments (id, tenant_id, patient_id, doctor_id, service_id, scheduled_start, scheduled_end, status, source, created_by, updated_by, updated_at, branch_id)
         VALUES ($1, $2, $3, $4, $5, '2031-01-06T09:00Z', '2031-01-06T09:30Z', 'BOOKED', 'RECEPTION', $6, $6, now(), $7)`,
        [ids.appt, t, clinic.patientId, clinic.doctorId, clinic.serviceId, u, b]);
      await client.query(
        `INSERT INTO appointment_events (id, tenant_id, appointment_id, event_type, actor_user_id) VALUES ($1, $2, $3, 'CREATED', $4)`,
        [ids.event, t, ids.appt, u]);
      await client.query(
        `INSERT INTO visits (id, tenant_id, patient_id, doctor_id, appointment_id, status, created_by, updated_at, branch_id)
         VALUES ($1, $2, $3, $4, $5, 'DRAFT', $6, now(), $7)`, [ids.visit, t, clinic.patientId, clinic.doctorId, ids.appt, u, b]);
      await client.query(
        `INSERT INTO visit_revisions (id, tenant_id, visit_id, changed_fields, previous_values, actor_user_id, reason)
         VALUES ($1, $2, $3, '[]', '{}', $4, 'test')`, [ids.revision, t, ids.visit, u]);
      await client.query(
        `INSERT INTO visit_procedures (id, tenant_id, visit_id, service_id, source, recorded_by_user_id)
         VALUES ($1, $2, $3, $4, 'DOCTOR', $5)`, [ids.procedure, t, ids.visit, clinic.serviceId, u]);
      await client.query(
        `INSERT INTO visit_charges (id, tenant_id, visit_id, patient_id) VALUES ($1, $2, $3, $4)`, [ids.charge, t, ids.visit, clinic.patientId]);
      await client.query(
        `INSERT INTO visit_charge_lines (id, tenant_id, charge_id, name_snapshot, unit_price_minor, source)
         VALUES ($1, $2, $3, 'Consult', 10000, 'AD_HOC')`, [ids.line, t, ids.charge]);
      await client.query(
        `INSERT INTO payments (id, tenant_id, patient_id, amount_minor, method, status, updated_at, charge_id)
         VALUES ($1, $2, $3, 10000, 'CASH', 'PAID', now(), $4)`, [ids.payment, t, clinic.patientId, ids.charge]);
      await client.query(
        `INSERT INTO payment_adjustments (id, tenant_id, payment_id, adjustment_type, amount_minor, reason, actor_user_id, previous_status, new_status)
         VALUES ($1, $2, $3, 'CORRECTION', 0, 'test', $4, 'PAID', 'PAID')`, [ids.adjustment, t, ids.payment, u]);
      const rows = await client.query<{ entity_type: string; scope: string; branch_id: string | null }>(
        `SELECT entity_type, scope::text AS scope, branch_id FROM audit_logs WHERE action = 'CREATE' AND entity_id = ANY($1)`,
        [[ids.brk, ids.event, ids.revision, ids.procedure, ids.line, ids.adjustment]]);
      return { b, rows: rows.rows };
    });
    expect(reaches.rows.map((r) => r.entity_type).sort()).toEqual(
      ["appointment_events", "payment_adjustments", "schedule_breaks", "visit_charge_lines", "visit_procedures", "visit_revisions"],
    );
    for (const row of reaches.rows) expect({ table: row.entity_type, scope: row.scope, branch: row.branch_id }).toEqual({ table: row.entity_type, scope: "ONE_BRANCH", branch: reaches.b });
  });

  test("a change to a branch row, such as allocating a receipt number, is ONE_BRANCH in that branch", async () => {
    const rows = await rolledBack(async () => {
      await client.query("UPDATE branches SET next_receipt_number = next_receipt_number + 1 WHERE id = $1", [clinic.branchId]);
      return (await client.query<{ scope: string; branch_id: string | null }>(
        "SELECT scope::text AS scope, branch_id FROM audit_logs WHERE entity_id = $1 AND action = 'UPDATE' AND created_at = now()",
        [clinic.branchId])).rows;
    });
    expect(rows).toEqual([{ scope: "ONE_BRANCH", branch_id: clinic.branchId }]);
  });

  test("a clinic-level row with no branch on the request is UNSCOPED; with one, ONE_BRANCH in it", async () => {
    const rows = await rolledBack(async () => {
      await client.query("UPDATE patients SET notes = 'a' WHERE id = $1", [clinic.patientId]);
      await client.query("SELECT set_config('app.current_branch_id', $1, true)", [clinic.branchId]);
      await client.query("UPDATE patients SET notes = 'b' WHERE id = $1", [clinic.patientId]);
      // Told apart by what each recorded, never by id: both are minted by Postgres in one millisecond.
      return (await client.query<{ notes: string; scope: string; branch_id: string | null }>(
        `SELECT new_state->>'notes' AS notes, scope::text AS scope, branch_id FROM audit_logs
          WHERE entity_id = $1 AND action = 'UPDATE' AND created_at = now()`,
        [clinic.patientId])).rows;
    });
    const byNotes = Object.fromEntries(rows.map((r) => [r.notes, { scope: r.scope, branch_id: r.branch_id }]));
    expect(rows).toHaveLength(2);
    expect(byNotes).toEqual({ a: { scope: "UNSCOPED", branch_id: null }, b: { scope: "ONE_BRANCH", branch_id: clinic.branchId } });
  });

  test("the database refuses a branch that disagrees with the scope, and any new BEFORE_BRANCHES row", async () => {
    const insert = `INSERT INTO audit_logs (id, tenant_id, actor_user_id, actor_role, action, entity_type, entity_id, ip_address, user_agent, branch_id, scope)
                    VALUES ($1, $2, $3, 'OWNER', 'CREATE', 'patients', $4, 'x', 'x', $5, $6)`;
    const tried = await rolledBack(async () => {
      const row = (branch: string | null, scope: string) => refusal(insert, [randomUUID(), clinic.tenantId, clinic.userId, clinic.patientId, branch, scope]);
      return {
        oneBranchWithoutBranch: await row(null, "ONE_BRANCH"),
        unscopedWithBranch: await row(clinic.branchId, "UNSCOPED"),
        beforeBranches: await row(null, "BEFORE_BRANCHES"),
        unscoped: await row(null, "UNSCOPED"),
        oneBranch: await row(clinic.branchId, "ONE_BRANCH"),
      };
    });
    expect(tried.oneBranchWithoutBranch).toContain("audit_logs_branch_matches_scope");
    expect(tried.unscopedWithBranch).toContain("audit_logs_branch_matches_scope");
    expect(tried.beforeBranches).toContain("BEFORE_BRANCHES is historical only");
    expect(tried).toMatchObject({ unscoped: "no error", oneBranch: "no error" });
  });

  test("every database function that writes an audit row states its scope, or is a named no-branch writer", async () => {
    const writers = (await client.query<{ proname: string; states_scope: boolean }>(
      `SELECT p.proname, p.prosrc ~ '\\mscope\\M' AS states_scope FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.prosrc ~* 'insert\\s+into\\s+"?audit_logs'`)).rows;
    expect(writers.length).toBeGreaterThan(NO_BRANCH_WRITERS.length);
    const silent = writers.filter((w) => !w.states_scope).map((w) => w.proname).sort();
    expect(silent).toEqual([...NO_BRANCH_WRITERS].sort());
  });

  describe("the sensitive read agrees with the trigger, in the same transaction", () => {
    const context = (selected: string): BranchContext =>
      ({ allowed: [clinic.branchId], selected, isMultiBranch: false, branches: [] });

    const readAndWrite = (selected: string) =>
      branchContext.run(context(selected), () =>
        withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) => {
          const appointmentId = randomUUID();
          const notes = randomUUID();
          const access = { appointmentId, patientId: clinic.patientId, doctorId: clinic.doctorId, status: "BOOKED",
            callerDoctorId: null, fullHistoryVia: null } as unknown as AccessContext;
          await recordSensitiveRead(tx, { tenantId: clinic.tenantId, actor: actorFor(clinic.userId), role: "DOCTOR", membershipId: clinic.membershipId },
            "DOCTOR", access, "SUMMARY");
          await tx.patient.update({ where: { id: clinic.patientId }, data: { notes } });
          // Picked by content, never by id order: the read's id is minted in Node, the trigger's in Postgres.
          return tx.auditLog.findMany({
            where: { entityId: clinic.patientId, OR: [
              { action: "READ_SENSITIVE", newState: { path: ["appointmentId"], equals: appointmentId } },
              { action: "UPDATE", newState: { path: ["notes"], equals: notes } },
            ] },
            select: { action: true, scope: true, branchId: true },
          });
        }));

    test("with one branch selected, both rows are ONE_BRANCH in it", async () => {
      const rows = await readAndWrite(clinic.branchId);
      expect(rows.map((r) => r.action).sort()).toEqual(["READ_SENSITIVE", "UPDATE"]);
      for (const r of rows) expect({ scope: r.scope, branchId: r.branchId }).toEqual({ scope: "ONE_BRANCH", branchId: clinic.branchId });
    });

    test("with no single branch, both rows are UNSCOPED, never dropped", async () => {
      const rows = await readAndWrite(ALL_BRANCHES);
      expect(rows.map((r) => r.action).sort()).toEqual(["READ_SENSITIVE", "UPDATE"]);
      for (const r of rows) expect({ scope: r.scope, branchId: r.branchId }).toEqual({ scope: "UNSCOPED", branchId: null });
    });
  });
});
