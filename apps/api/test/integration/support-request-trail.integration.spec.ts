// Support access PR 4 (docs/SUPPORT-ACCESS.md): both identities on every audit row written under a support session, whoever writes
// it, and every request recorded, reads included, numbered in order up to 300; the 301st ends the session and says why.
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { Client } from "pg";
import { uuidv7 } from "uuidv7";
import { AppModule } from "../../src/app.module.ts";
import { refusingValidationPipe } from "../../src/common/validation-pipe.ts";
import { issuePlatformToken } from "../../src/modules/platform/platform-token.ts";
import { allowChanges, openSession } from "../../src/modules/support/support-sessions.ts";
import { prisma } from "../../src/prisma/client.ts";
import { injected, injectedIdOnly } from "../../src/prisma/injected.ts";
import { type TransactionClient, withPlatformActor, withTenant } from "../../src/prisma/with-tenant.ts";
import { actorFor, createTestUser, databaseNow, deleteTestUser, makeOperator, seedClinic, teardownClinic, type ClinicFixture } from "./fixtures.ts";

describe("the support request trail and both identities (support access PR 4)", () => {
  let app: NestExpressApplication;
  let baseUrl = "";
  let clinic: ClinicFixture;
  const users: string[] = [];
  const ids = { operator: "", admin: "", adminMembership: "" };
  let operatorToken = "";

  const as = <T>(work: (tx: TransactionClient) => Promise<T>): Promise<T> => withTenant(clinic.tenantId, actorFor(clinic.userId), work);
  const owner = () => new Client({ connectionString: process.env["TEST_OBSERVER_URL"] ?? process.env["DATABASE_URL"] ?? "" });
  const get = (token: string, path: string) => fetch(`${baseUrl}${path}`, { headers: { authorization: `Bearer ${token}` } }).then((r) => r.status);
  const live = async () => (await openSession({ tenantId: clinic.tenantId, actor: actorFor(ids.admin) }, { operatorId: ids.operator, reason: "diagnosis" }, new Date()) as { ok: true; value: { id: string } }).value.id;
  const writable = async () => {
    const id = await live();
    await allowChanges({ tenantId: clinic.tenantId, actor: actorFor(ids.admin) }, id, new Date());
    return id;
  };
  const supportToken = async (sessionId: string) => {
    const r = await fetch(`${baseUrl}/platform/support-sessions/clinics/${clinic.tenantId}/${sessionId}/token`, { method: "POST", headers: { authorization: `Bearer ${operatorToken}` } });
    return ((await r.json()) as { token: string }).token;
  };
  const record = async (sessionId: string) =>
    (await prisma.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM record_support_request(${sessionId}::uuid, ${ids.operator}::uuid, ${ids.adminMembership}::uuid, 30, 'GET', '/probe')`)[0]!.n;
  const requests = (sessionId: string) => as((tx) => tx.supportSessionRequest.findMany({ where: { sessionId }, orderBy: { seq: "asc" } }));
  const supportActor = (sessionId: string) => ({ ...actorFor(ids.operator), supportSessionId: sessionId });
  const endAll = () => as((tx) => tx.supportSession.updateMany({ where: { status: "ACTIVE" }, data: { status: "ENDED", endedAt: new Date(), endReason: "test" } }));

  beforeAll(async () => {
    process.env["ATTACHMENTS_STORAGE_ROOT"] ??= process.cwd();
    clinic = await seedClinic();
    ids.operator = await createTestUser();
    users.push(ids.operator);
    await makeOperator(ids.operator);
    operatorToken = await issuePlatformToken(ids.operator, "full");
    ids.admin = await createTestUser();
    users.push(ids.admin);
    ids.adminMembership = randomUUID();
    await as((tx) => tx.membership.create({ data: injected({ id: ids.adminMembership, userId: ids.admin, role: "ADMIN", status: "ACTIVE" }) }));
    await withPlatformActor(actorFor(ids.operator), async (tx) => {
      await tx.platformClinicContract.create({ data: { id: uuidv7(), tenantId: clinic.tenantId, fileName: "a.pdf", storageKey: `test/${uuidv7()}`, mimeType: "application/pdf", sizeBytes: 1,
        startsOn: new Date(Date.now() - 86_400_000), endsOn: new Date(Date.now() + 365 * 86_400_000), dataProcessorClause: true, uploadedByUserId: ids.operator } });
      await tx.tenant.update({ where: { id: clinic.tenantId }, data: { supportAccessEnabled: true } });
    });
    app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: false });
    app.useGlobalPipes(refusingValidationPipe());
    await app.listen(0);
    baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  });

  afterEach(endAll);

  afterAll(async () => {
    await app?.close();
    await teardownClinic(clinic);
    for (const id of users) await deleteTestUser(id);
  });

  test("every request is recorded, reads included, in order, and the clinic can read the record", async () => {
    const id = await live();
    const token = await supportToken(id);
    expect(await get(token, "/support-sessions/live")).toBe(200);
    expect(await get(token, "/support-sessions/live?probe=1")).toBe(200);
    const rows = await requests(id);
    expect(rows.map((r) => [r.seq, r.method, r.path])).toEqual([[1, "GET", "/support-sessions/live"], [2, "GET", "/support-sessions/live?probe=1"]]);
  });

  test("a request refused because the session ended is not recorded", async () => {
    const id = await live();
    const token = await supportToken(id);
    await endAll();
    expect(await get(token, "/support-sessions/live")).toBe(401);
    expect(await requests(id)).toEqual([]);
  });

  test("concurrent requests are numbered without a gap or a repeat", async () => {
    const id = await live();
    expect(await Promise.all(Array.from({ length: 20 }, () => record(id)))).toEqual(Array(20).fill(1));
    expect((await requests(id)).map((r) => r.seq)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
  });

  test("the 301st request ends the session, by the system, saying why", async () => {
    const id = await live();
    for (let i = 0; i < 300; i++) expect(await record(id)).toBe(1);
    expect(await record(id)).toBe(0);
    expect((await requests(id)).length).toBe(300);
    const session = await as((tx) => tx.supportSession.findUniqueOrThrow({ where: { id } }));
    expect(session).toMatchObject({ status: "ENDED", endReason: "request cap reached: 300 requests", endedBy: null });
  });

  test("every audit row written under a support session names the operator, SUPPORT, the session and its approver, whoever writes it", async () => {
    const id = await writable();
    const before = await databaseNow();
    await withTenant(clinic.tenantId, supportActor(id), async (tx) => {
      await tx.patient.update({ where: { id: clinic.patientId }, data: { notes: "support read the file" } });
      await tx.auditLog.create({ data: injectedIdOnly({ tenantId: clinic.tenantId, actorUserId: ids.operator, actorRole: "ADMIN", action: "READ_SENSITIVE", entityType: "patients", entityId: clinic.patientId, ipAddress: "t", userAgent: "t", scope: "UNSCOPED" }) });
    });
    const rows = await as((tx) => tx.auditLog.findMany({ where: { createdAt: { gte: before }, actorUserId: ids.operator } }));
    expect(rows.length).toBe(2);
    for (const row of rows) expect(row).toMatchObject({ actorRole: "SUPPORT", supportSessionId: id, supportApproverId: ids.admin });
  });

  test("a row written by a definer-owned audit function under a session is stamped too, not refused", async () => {
    const id = await writable();
    const before = await databaseNow();
    await withTenant(clinic.tenantId, supportActor(id), (tx) => tx.tenant.update({ where: { id: clinic.tenantId }, data: { commercialRegisterNumber: "CR-support" } }));
    const rows = await as((tx) => tx.auditLog.findMany({ where: { createdAt: { gte: before }, entityType: "tenants", entityId: clinic.tenantId } }));
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({ actorUserId: ids.operator, actorRole: "SUPPORT", supportSessionId: id, supportApproverId: ids.admin });
  });

  test("outside a session no row carries support identities, and none may claim SUPPORT", async () => {
    const before = await databaseNow();
    await as((tx) => tx.patient.update({ where: { id: clinic.patientId }, data: { notes: "the clinic wrote this" } }));
    const rows = await as((tx) => tx.auditLog.findMany({ where: { createdAt: { gte: before }, entityId: clinic.patientId } }));
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row).toMatchObject({ supportSessionId: null, supportApproverId: null });
    await expect(as((tx) => tx.auditLog.create({ data: injectedIdOnly({ tenantId: clinic.tenantId, actorUserId: clinic.userId, actorRole: "SUPPORT", action: "READ_SENSITIVE", entityType: "patients", entityId: clinic.patientId, ipAddress: "t", userAgent: "t", scope: "UNSCOPED" }) }))).rejects.toThrow("audit_logs_support_role");
  });

  test("the record is append-only, even to the owner of the table", async () => {
    const id = await live();
    await record(id);
    const c = owner();
    await c.connect();
    try {
      await expect(c.query("UPDATE support_session_requests SET path = '/rewritten' WHERE session_id = $1", [id])).rejects.toThrow("append-only");
      await expect(c.query("DELETE FROM support_session_requests WHERE session_id = $1", [id])).rejects.toThrow("append-only");
    } finally {
      await c.end();
    }
  });
});
