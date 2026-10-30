// Branches step 4b stage 5: nothing fills a branch any more. A row that names none is refused, and every
// branch column is NOT NULL except the two whose null is an explicit value, each held by its CHECK.
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { prisma } from "../../src/prisma/client.ts";
import { seedClinic, teardownClinic, type ClinicFixture } from "./fixtures.ts";

// Null is a value in these two, never a gap: EVERY_BRANCH (§4.4) and UNSCOPED or BEFORE_BRANCHES (§4.6).
const NULL_MEANS_A_VALUE: Record<string, string> = {
  schedule_exceptions: "schedule_exceptions_branch_matches_scope",
  audit_logs: "audit_logs_branch_matches_scope",
};

const ownerUrl = (): string => process.env["TEST_OBSERVER_URL"] ?? process.env["DATABASE_URL"] ?? "";

describe("no branch is filled in, and none is missing", () => {
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

  test("every branch_id column is NOT NULL, except the two whose null means something, and each has its CHECK", async () => {
    const columns = (await client.query<{ table_name: string; is_nullable: string }>(
      "SELECT table_name, is_nullable FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'branch_id' ORDER BY table_name",
    )).rows;
    expect(columns.length).toBeGreaterThan(Object.keys(NULL_MEANS_A_VALUE).length);
    expect(columns.filter((c) => c.is_nullable === "YES").map((c) => c.table_name).sort()).toEqual(Object.keys(NULL_MEANS_A_VALUE).sort());

    const checks = (await client.query<{ conname: string }>(
      "SELECT conname FROM pg_constraint WHERE contype = 'c' AND conname = ANY($1)", [Object.values(NULL_MEANS_A_VALUE)],
    )).rows.map((r) => r.conname).sort();
    expect(checks).toEqual(Object.values(NULL_MEANS_A_VALUE).sort());
  });

  // In a single-branch clinic, the one place a fill could still guess. Each runs in a rolled-back transaction.
  const refusalOf = async (sql: string, params: unknown[]): Promise<string> => {
    await client.query("BEGIN");
    try {
      await client.query("SELECT set_config('app.current_tenant_id', $1, true), set_config('app.current_actor_id', $2, true)", [clinic.tenantId, clinic.userId]);
      await client.query(sql, params);
      return "accepted";
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    } finally {
      await client.query("ROLLBACK");
    }
  };

  test("an appointment naming no branch is refused, never given one, even with one branch", async () => {
    expect(await refusalOf(
      `INSERT INTO appointments (id, tenant_id, patient_id, doctor_id, service_id, scheduled_start, scheduled_end, status, source, created_by, updated_by, updated_at)
       VALUES ($1, $2, $3, $4, $5, '2031-03-03T09:00Z', '2031-03-03T09:30Z', 'BOOKED', 'RECEPTION', $6, $6, now())`,
      [randomUUID(), clinic.tenantId, clinic.patientId, clinic.doctorId, clinic.serviceId, clinic.userId],
    )).toContain("branch_id");
  });

  test("a schedule template naming no branch is refused, never given one, even with one branch", async () => {
    expect(await refusalOf(
      `INSERT INTO schedule_templates (id, tenant_id, doctor_id, weekday, start_time, end_time, valid_from, updated_at)
       VALUES ($1, $2, $3, 1, '09:00', '13:00', '2031-01-01', now())`,
      [randomUUID(), clinic.tenantId, clinic.doctorId],
    )).toContain("branch_id");
  });

  test("a receipt paying for nothing is refused, never given the sole branch", async () => {
    expect(await refusalOf(
      "INSERT INTO payments (id, tenant_id, patient_id, amount_minor, method, status, updated_at) VALUES ($1, $2, $3, 100, 'CASH', 'PAID', now())",
      [randomUUID(), clinic.tenantId, clinic.patientId],
    )).toContain("names no charge, visit or appointment");
  });
});
