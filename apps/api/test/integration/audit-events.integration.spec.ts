// One transaction is one audit event, shown with no order inside it (ruled 2026-10-29). Forty rows
// written by one statement land in a millisecond or two, where ids are random relative to each other.
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { uuidv7 } from "uuidv7";
import { branchContext } from "../../src/common/branch-context.ts";
import { ALL_BRANCHES } from "../../src/common/branch-scope.ts";
import { listAuditLog } from "../../src/modules/audit/audit.service.ts";
import { recordSensitiveRead, type AccessContext } from "../../src/modules/clinical/clinical.access.ts";
import { prisma } from "../../src/prisma/client.ts";
import { withTenant } from "../../src/prisma/with-tenant.ts";
import { actorFor, seedClinic, teardownClinic, type ClinicFixture } from "./fixtures.ts";

const ROWS = 40;
const ownerUrl = (): string => process.env["TEST_OBSERVER_URL"] ?? process.env["DATABASE_URL"] ?? "";

describe("audit events", () => {
  let clinic: ClinicFixture;
  // Node ids, minted in one process, increase strictly: this is the order the rows were written in.
  const written = Array.from({ length: ROWS }, () => uuidv7());
  let auditIdsByWriteOrder: string[] = [];

  beforeAll(async () => {
    clinic = await seedClinic();
    const client = new Client({ connectionString: ownerUrl() });
    await client.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.current_tenant_id', $1, true), set_config('app.current_actor_id', $2, true)", [clinic.tenantId, clinic.userId]);
      await client.query(
        `INSERT INTO patients (id, tenant_id, full_name_ar, phone_e164, relationship_to_contact, status, updated_at)
         SELECT w.id, $2, 'Audit order ' || w.n, '+2012' || lpad((floor(random() * 1e8))::bigint::text, 8, '0'), 'SELF', 'ACTIVE', now()
           FROM unnest($1::uuid[]) WITH ORDINALITY AS w(id, n)`,
        [written, clinic.tenantId],
      );
      await client.query("COMMIT");
      const audit = await client.query<{ id: string; entity_id: string }>(
        "SELECT id, entity_id FROM audit_logs WHERE entity_type = 'patients' AND action = 'CREATE' AND entity_id = ANY($1)", [written]);
      const byEntity = new Map(audit.rows.map((r) => [r.entity_id, r.id]));
      auditIdsByWriteOrder = written.map((id) => byEntity.get(id)!);
    } finally {
      await client.end();
    }
  });

  afterAll(async () => {
    await teardownClinic(clinic);
    await prisma.$disconnect();
  });

  test("the hazard is real: the audit ids of one statement do not sort in the order it wrote them", () => {
    expect(auditIdsByWriteOrder).toHaveLength(ROWS);
    expect([...auditIdsByWriteOrder].sort()).not.toEqual(auditIdsByWriteOrder);
  });

  test("the viewer shows the statement as one event, its rows by entity, never by id", async () => {
    const page = await listAuditLog(
      { tenantId: clinic.tenantId, actor: actorFor(clinic.userId) },
      { entityType: "patients", actorUserId: clinic.userId, limit: 200 },
    );
    const holding = page.events.filter((event) => event.entries.some((entry) => written.includes(entry.entityId)));
    expect(holding).toHaveLength(1);
    const shown = holding[0]!.entries.filter((entry) => written.includes(entry.entityId)).map((entry) => entry.entityId);
    expect(shown).toHaveLength(ROWS);
    expect(shown).toEqual([...written].sort());
  });

  test("a row the application writes shares its transaction's instant, so it joins that event", async () => {
    const appointmentId = randomUUID();
    const notes = randomUUID();
    await withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) => {
      const access = { appointmentId, patientId: clinic.patientId, doctorId: clinic.doctorId, status: "BOOKED",
        callerDoctorId: null, fullHistoryVia: null } as unknown as AccessContext;
      await recordSensitiveRead(tx, { tenantId: clinic.tenantId, actor: actorFor(clinic.userId), role: "DOCTOR", membershipId: clinic.membershipId },
        "DOCTOR", access, "SUMMARY");
      await tx.patient.update({ where: { id: clinic.patientId }, data: { notes } });
    });
    const page = await listAuditLog({ tenantId: clinic.tenantId, actor: actorFor(clinic.userId) }, { actorUserId: clinic.userId, limit: 200 });
    const read = page.events.find((event) => event.entries.some((entry) => entry.action === "READ_SENSITIVE" && entry.entityId === clinic.patientId));
    expect(read?.entries.map((entry) => entry.action).sort()).toEqual(["READ_SENSITIVE", "UPDATE"]);
  });

  test("an event not tied to one branch is labelled only in a multi-branch clinic (§6)", async () => {
    const caller = { tenantId: clinic.tenantId, actor: actorFor(clinic.userId) };
    const filters = { entityType: "patients", actorUserId: clinic.userId, limit: 200 };
    const ours = (page: Awaited<ReturnType<typeof listAuditLog>>) =>
      page.events.find((event) => event.entries.some((entry) => written.includes(entry.entityId)))!;
    const single = await branchContext.run({ allowed: [clinic.branchId], selected: ALL_BRANCHES, isMultiBranch: false, branches: [] }, () => listAuditLog(caller, filters));
    const multi = await branchContext.run({ allowed: [clinic.branchId], selected: ALL_BRANCHES, isMultiBranch: true, branches: [] }, () => listAuditLog(caller, filters));
    expect(ours(single).reach).toBeNull();
    expect(ours(multi).reach).toBe("UNSCOPED");
  });

  test("an event of 5,000 rows returns its first 50, by entity, and says 5,000", async () => {
    const big = Array.from({ length: 5000 }, () => uuidv7());
    const client = new Client({ connectionString: ownerUrl() });
    await client.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.current_tenant_id', $1, true), set_config('app.current_actor_id', $2, true)", [clinic.tenantId, clinic.userId]);
      await client.query(
        `INSERT INTO patients (id, tenant_id, full_name_ar, phone_e164, relationship_to_contact, status, updated_at)
         SELECT w.id, $2, 'Bulk ' || w.n, '+2014' || lpad(w.n::text, 8, '0'), 'SELF', 'ACTIVE', now()
           FROM unnest($1::uuid[]) WITH ORDINALITY AS w(id, n)`,
        [big, clinic.tenantId],
      );
      await client.query("COMMIT");
    } finally {
      await client.end();
    }
    const page = await listAuditLog({ tenantId: clinic.tenantId, actor: actorFor(clinic.userId) }, { entityType: "patients", actorUserId: clinic.userId, limit: 200 });
    const event = page.events.find((e) => e.entries.some((entry) => big.includes(entry.entityId)))!;
    expect(event.entryCount).toBe(5000);
    expect(event.entries.map((entry) => entry.entityId)).toEqual([...big].sort().slice(0, 50));
  }, 120_000);

  test("pagination counts events, not rows", async () => {
    const caller = { tenantId: clinic.tenantId, actor: actorFor(clinic.userId) };
    const all = await listAuditLog(caller, { entityType: "patients", actorUserId: clinic.userId, limit: 200 });
    const rows = all.events.reduce((sum, event) => sum + event.entries.length, 0);
    expect(all.total).toBe(all.events.length);
    expect(rows).toBeGreaterThan(all.events.length);
    expect((await listAuditLog(caller, { entityType: "patients", actorUserId: clinic.userId, limit: 1 })).events).toHaveLength(1);
  });
});
