// Branches step 6.1 (§9 ruling A): the operator sets a clinic's max_branches, each change is an append-only history row
// in the clinic's trail too, and the database refuses an ACTIVE branch past the limit, even when two race for the last room.
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { Client } from "pg";
import { AppModule } from "../../src/app.module.ts";
import { refusingValidationPipe } from "../../src/common/validation-pipe.ts";
import { issuePlatformToken } from "../../src/modules/platform/platform-token.ts";
import { injected } from "../../src/prisma/injected.ts";
import { type TransactionClient, withTenant } from "../../src/prisma/with-tenant.ts";
import { actorFor, createTestUser, deleteTestUser, makeOperator, seedClinic, teardownClinic, type ClinicFixture } from "./fixtures.ts";

describe("the branch limit (step 6.1)", () => {
  let app: NestExpressApplication;
  let baseUrl = "";
  let clinic: ClinicFixture;
  let operatorId = "";
  let token = "";

  const as = <T>(work: (tx: TransactionClient) => Promise<T>): Promise<T> => withTenant(clinic.tenantId, actorFor(clinic.userId), work);
  const setLimit = (tenantId: string, body: Record<string, unknown>) =>
    fetch(`${baseUrl}/platform/clinics/${tenantId}/branch-limit`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const newBranch = (status: "ACTIVE" | "SUSPENDED" = "ACTIVE") => {
    const id = randomUUID();
    return as((tx) => tx.branch.create({ data: injected({ id, name: `b-${id.slice(0, 6)}`, address: "Giza", phone: "+201000000001", receiptPrefix: id.slice(0, 4), invoicePrefix: id.slice(0, 4),
      ...(status === "SUSPENDED" ? { status, suspendedAt: new Date(), suspensionReason: "test" } : {}) }) })).then(() => id);
  };
  const refusal = (work: Promise<unknown>) => work.then(() => "no error", (error: Error) => error.message);
  const ownerClient = () => new Client({ connectionString: process.env["TEST_OBSERVER_URL"] ?? process.env["DATABASE_URL"] ?? "" });

  beforeAll(async () => {
    process.env["ATTACHMENTS_STORAGE_ROOT"] ??= process.cwd();
    clinic = await seedClinic();
    await as((tx) => tx.tenant.update({ where: { id: clinic.tenantId }, data: { maxBranches: 1 } }));
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

  test("at its limit a clinic cannot gain an ACTIVE branch, by creation or by reactivation", async () => {
    expect(await refusal(newBranch())).toContain("branch limit reached");
    const parked = await newBranch("SUSPENDED");
    expect(await refusal(as((tx) => tx.branch.update({ where: { id: parked }, data: { status: "ACTIVE", suspendedAt: null, suspensionReason: null } })))).toContain("branch limit reached");
  });

  test("the operator raises the limit: the clinic's row, a history row with who and why, and a row in the clinic's trail", async () => {
    const response = await setLimit(clinic.tenantId, { maxBranches: 3, reason: "multi-branch add-on signed" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ maxBranches: 3, previousLimit: 1, activeBranches: 1 });
    const history = await as((tx) => tx.branchLimitChange.findMany({ select: { previousLimit: true, newLimit: true, reason: true, changedBy: true } }));
    expect(history).toEqual([{ previousLimit: 1, newLimit: 3, reason: "multi-branch add-on signed", changedBy: operatorId }]);
    const trail = await as((tx) => tx.auditLog.findMany({ where: { entityType: "tenants", actorUserId: operatorId }, select: { newState: true } }));
    expect(trail.some((row) => (row.newState as { maxBranches?: number } | null)?.maxBranches === 3)).toBe(true);
    expect(await refusal(newBranch())).toBe("no error");
  });

  test("two branches racing for the last room: the second waits for the first, then is refused", async () => {
    const active = await as((tx) => tx.branch.count({ where: { status: "ACTIVE" } }));
    await as((tx) => tx.tenant.update({ where: { id: clinic.tenantId }, data: { maxBranches: active + 1 } }));
    const [first, second] = [ownerClient(), ownerClient()];
    await Promise.all([first.connect(), second.connect()]);
    const insert = async (client: Client) => {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.current_tenant_id', $1, true), set_config('app.current_actor_id', $2, true)", [clinic.tenantId, clinic.userId]);
      const id = randomUUID();
      await client.query("INSERT INTO branches (id, tenant_id, name, address, phone, receipt_prefix, invoice_prefix, updated_at) VALUES ($1, $2, $3, 'Giza', '+201000000001', $4, $4, now())",
        [id, clinic.tenantId, `race-${id.slice(0, 6)}`, id.slice(0, 4)]);
    };
    try {
      await insert(first);
      const late = refusal(insert(second));
      await new Promise((resolve) => setTimeout(resolve, 300));
      await first.query("COMMIT");
      expect(await late).toContain("branch limit reached");
    } finally {
      await second.query("ROLLBACK").catch(() => undefined);
      await Promise.all([first.end(), second.end()]);
    }
  });

  test("refusals: the same limit, no reason, below one, an unknown clinic", async () => {
    const current = (await as((tx) => tx.tenant.findUniqueOrThrow({ where: { id: clinic.tenantId }, select: { maxBranches: true } }))).maxBranches;
    expect((await setLimit(clinic.tenantId, { maxBranches: current, reason: "again" })).status).toBe(422);
    expect((await setLimit(clinic.tenantId, { maxBranches: current + 1, reason: "  " })).status).toBe(422);
    expect((await setLimit(clinic.tenantId, { maxBranches: 0, reason: "none" })).status).toBe(400);
    expect((await setLimit(randomUUID(), { maxBranches: 2, reason: "x" })).status).toBe(404);
  });

  test("lowering the limit below the active count suspends nothing here, and the history cannot be rewritten", async () => {
    expect((await setLimit(clinic.tenantId, { maxBranches: 1, reason: "add-on cancelled" })).status).toBe(200);
    expect(await as((tx) => tx.branch.count({ where: { status: "ACTIVE" } }))).toBeGreaterThan(1);
    const owner = new Client({ connectionString: process.env["TEST_OBSERVER_URL"] ?? process.env["DATABASE_URL"] ?? "" });
    await owner.connect();
    try {
      const tried = await owner.query("UPDATE branch_limit_changes SET reason = 'rewritten' WHERE tenant_id = $1", [clinic.tenantId]).then(() => "no error", (e: Error) => e.message);
      expect(tried).toContain("append-only");
    } finally {
      await owner.end();
    }
  });
});
