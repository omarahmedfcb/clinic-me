// Branches 6.5 (Q8 ruled 2026-10-31): the operator opening a clinic's file is a READ_SENSITIVE in the vendor's trail,
// naming the operator, and in the clinic's own, as read by the platform and naming nobody. A cross-clinic list: vendor only.
import type { AddressInfo } from "node:net";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { Client } from "pg";
import { AppModule } from "../../src/app.module.ts";
import { refusingValidationPipe } from "../../src/common/validation-pipe.ts";
import { listAuditLog } from "../../src/modules/audit/audit.service.ts";
import { issuePlatformToken } from "../../src/modules/platform/platform-token.ts";
import { actorFor, createTestUser, deleteTestUser, makeOperator, seedClinic, teardownClinic, type ClinicFixture } from "./fixtures.ts";

describe("operator reads, in both trails (step 6.5)", () => {
  let app: NestExpressApplication;
  let baseUrl = "";
  let clinic: ClinicFixture;
  let operatorId = "";
  let token = "";
  const owner = () => new Client({ connectionString: process.env["TEST_OBSERVER_URL"] ?? process.env["DATABASE_URL"] ?? "" });
  async function rows(sql: string, params: unknown[]): Promise<Record<string, unknown>[]> {
    const client = owner();
    await client.connect();
    try {
      return (await client.query(sql, params)).rows;
    } finally {
      await client.end();
    }
  }
  const get = (path: string) => fetch(`${baseUrl}${path}`, { headers: { authorization: `Bearer ${token}` } });

  beforeAll(async () => {
    process.env["ATTACHMENTS_STORAGE_ROOT"] ??= process.cwd();
    clinic = await seedClinic();
    operatorId = await createTestUser();
    await makeOperator(operatorId);
    token = await issuePlatformToken(operatorId, "full");
    app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: false });
    app.useGlobalPipes(refusingValidationPipe());
    await app.listen(0);
    baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await app?.close();
    await teardownClinic(clinic);
    await deleteTestUser(operatorId);
  });

  test("opening a clinic's file: the vendor's trail names the operator, the clinic's says the platform and names nobody", async () => {
    expect((await get(`/platform/clinics/${clinic.tenantId}/file`)).status).toBe(200);
    const vendor = await rows(
      "SELECT actor_user_id, actor_role FROM audit_logs WHERE tenant_id IS NULL AND action = 'READ_SENSITIVE' AND entity_id = $1 AND actor_user_id = $2", [clinic.tenantId, operatorId]);
    expect(vendor).toEqual([{ actor_user_id: operatorId, actor_role: "PLATFORM_ADMIN" }]);
    const mine = await rows("SELECT actor_user_id, actor_role, new_state FROM audit_logs WHERE tenant_id = $1 AND action = 'READ_SENSITIVE'", [clinic.tenantId]);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ actor_role: "PLATFORM", new_state: { what: "client file", readBy: "platform" } });
    expect(mine[0]!["actor_user_id"]).not.toBe(operatorId);

    const page = await listAuditLog({ tenantId: clinic.tenantId, actor: actorFor(clinic.userId) }, { limit: 200 });
    const seen = page.events.flatMap((event) => event.entries.map((entry) => ({ ...entry, actorName: event.actorName }))).find((entry) => entry.action === "READ_SENSITIVE");
    expect(seen).toMatchObject({ actorName: "Platform", actorRole: "PLATFORM" });
  });

  test("the cross-clinic list is recorded in the vendor's trail only, never in every clinic's", async () => {
    const before = await rows("SELECT count(*)::int AS n FROM audit_logs WHERE tenant_id = $1 AND action = 'READ_SENSITIVE'", [clinic.tenantId]);
    expect((await get("/platform/clinics")).status).toBe(200);
    const vendor = await rows("SELECT new_state FROM audit_logs WHERE tenant_id IS NULL AND action = 'READ_SENSITIVE' AND actor_user_id = $1 AND entity_type = 'tenants' AND entity_id = $1", [operatorId]);
    expect(vendor.length).toBeGreaterThan(0);
    expect(await rows("SELECT count(*)::int AS n FROM audit_logs WHERE tenant_id = $1 AND action = 'READ_SENSITIVE'", [clinic.tenantId])).toEqual(before);
  });
});
