// Support access PR 5a (docs/SUPPORT-ACCESS.md ruling 2): a support session is read-only until the admin who approved it allows
// changes, once, for the rest of the session; the request check and the database each refuse a write before that.
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { Client } from "pg";
import { uuidv7 } from "uuidv7";
import { AppModule } from "../../src/app.module.ts";
import { refusingValidationPipe } from "../../src/common/validation-pipe.ts";
import { issueAccessToken } from "../../src/modules/auth/jwt.ts";
import { issuePlatformToken } from "../../src/modules/platform/platform-token.ts";
import { allowChanges, changeSession, openSession, settle } from "../../src/modules/support/support-sessions.ts";
import { injected } from "../../src/prisma/injected.ts";
import { type TransactionClient, withPlatformActor, withTenant } from "../../src/prisma/with-tenant.ts";
import { actorFor, createTestUser, databaseNow, deleteTestUser, makeOperator, seedClinic, teardownClinic, type ClinicFixture } from "./fixtures.ts";

describe("a support session is read-only until the approving admin allows changes (support access PR 5a)", () => {
  let app: NestExpressApplication;
  let baseUrl = "";
  let clinic: ClinicFixture;
  const users: string[] = [];
  const ids = { operator: "", operator2: "", admin: "", otherAdmin: "" };
  const tokens = { operator: "", otherAdmin: "" };

  const as = <T>(work: (tx: TransactionClient) => Promise<T>): Promise<T> => withTenant(clinic.tenantId, actorFor(clinic.userId), work);
  const sql = async (text: string, params: unknown[] = []) => {
    const c = new Client({ connectionString: process.env["TEST_OBSERVER_URL"] ?? process.env["DATABASE_URL"] ?? "" });
    await c.connect();
    try {
      await c.query("BEGIN");
      await c.query("SELECT set_config('app.current_actor_id', system_actor_id()::text, true), set_config('app.current_tenant_id', $1, true)", [clinic.tenantId]);
      const rows = (await c.query(text, params)).rows;
      await c.query("COMMIT");
      return rows;
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      await c.end();
    }
  };
  const admin = () => ({ tenantId: clinic.tenantId, actor: actorFor(ids.admin) });
  const live = async (operatorId = ids.operator) => (await openSession(admin(), { operatorId, reason: "diagnosis" }, new Date()) as { ok: true; value: { id: string } }).value.id;
  const supportToken = async (sessionId: string) => {
    const r = await fetch(`${baseUrl}/platform/support-sessions/clinics/${clinic.tenantId}/${sessionId}/token`, { method: "POST", headers: { authorization: `Bearer ${tokens.operator}` } });
    return ((await r.json()) as { token: string }).token;
  };
  const call = async (token: string, method: string, path: string, body = "{}") => {
    const r = await fetch(`${baseUrl}${path}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: method === "GET" ? undefined : body });
    return { status: r.status, body: (await r.json()) as Record<string, unknown> };
  };
  const writePatient = (sessionId: string) =>
    withTenant(clinic.tenantId, { ...actorFor(ids.operator), supportSessionId: sessionId }, (tx) => tx.patient.update({ where: { id: clinic.patientId }, data: { notes: `support ${randomUUID()}` } }));
  const endAll = () => as((tx) => tx.supportSession.updateMany({ where: { status: "ACTIVE" }, data: { status: "ENDED", endedAt: new Date(), endReason: "test" } }));

  beforeAll(async () => {
    process.env["ATTACHMENTS_STORAGE_ROOT"] ??= process.cwd();
    clinic = await seedClinic();
    for (const key of ["operator", "operator2"] as const) {
      ids[key] = await createTestUser();
      users.push(ids[key]);
      await makeOperator(ids[key]);
    }
    tokens.operator = await issuePlatformToken(ids.operator, "full");
    for (const key of ["admin", "otherAdmin"] as const) {
      ids[key] = await createTestUser();
      users.push(ids[key]);
      const membershipId = randomUUID();
      await as((tx) => tx.membership.create({ data: injected({ id: membershipId, userId: ids[key], role: "ADMIN", status: "ACTIVE" }) }));
      if (key === "otherAdmin") tokens.otherAdmin = await issueAccessToken({ sub: ids[key], membershipId, tenantId: clinic.tenantId, role: "ADMIN" });
    }
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

  test("a new session is read-only: the database refuses a write even with the application bypassed", async () => {
    const id = await live();
    await expect(writePatient(id)).rejects.toThrow("read-only");
  });

  test("over HTTP a write is refused with SUPPORT_READ_ONLY and still recorded, and a read answers", async () => {
    const id = await live();
    const token = await supportToken(id);
    expect(await call(token, "PUT", "/clinic-identity", JSON.stringify({ commercialRegisterNumber: "CR-read-only" }))).toEqual({ status: 403, body: { code: "SUPPORT_READ_ONLY", params: {} } });
    expect(await call(token, "POST", "/notifications/read", JSON.stringify({ ids: [] }))).toEqual({ status: 403, body: { code: "SUPPORT_READ_ONLY", params: {} } });
    expect((await call(token, "GET", "/support-sessions/live")).status).toBe(200);
    const recorded = await as((tx) => tx.supportSessionRequest.findMany({ where: { sessionId: id }, orderBy: { seq: "asc" } }));
    expect(recorded.map((r) => r.method)).toEqual(["PUT", "POST", "GET"]);
  });

  test("over HTTP, a write allowed under a support token is audited as SUPPORT, with the session and the approver", async () => {
    const id = await live();
    await allowChanges(admin(), id, new Date());
    const token = await supportToken(id);
    const before = await databaseNow();
    expect((await call(token, "PUT", "/clinic-identity", JSON.stringify({ commercialRegisterNumber: "CR-over-http" }))).status).toBe(200);
    const rows = await as((tx) => tx.auditLog.findMany({ where: { createdAt: { gte: before }, entityType: "tenants", entityId: clinic.tenantId } }));
    expect(rows.map((r) => [r.actorUserId, r.actorRole, r.supportSessionId, r.supportApproverId])).toEqual([[ids.operator, "SUPPORT", id, ids.admin]]);
    const recorded = await as((tx) => tx.supportSessionRequest.findMany({ where: { sessionId: id } }));
    expect(recorded.map((r) => [r.method, r.path])).toEqual([["PUT", "/clinic-identity"]]);
  });

  test("only the approving admin allows changes, on a live session, once; then the write lands, stamped", async () => {
    const id = await live();
    expect(await call(tokens.otherAdmin, "POST", `/support-sessions/${id}/allow-changes`)).toEqual({ status: 422, body: { code: "NOT_THE_APPROVER", params: {} } });
    const first = await allowChanges(admin(), id, new Date());
    const again = await allowChanges(admin(), id, new Date(Date.now() + 60_000));
    expect(first.ok && again.ok && again.value.changesAllowedAt.getTime() === first.value.changesAllowedAt.getTime()).toBe(true);
    const token = await supportToken(id);
    expect(await call(token, "POST", `/support-sessions/${id}/allow-changes`)).toEqual({ status: 422, body: { code: "NOT_THE_APPROVER", params: {} } });
    const before = await databaseNow();
    await writePatient(id);
    const rows = await as((tx) => tx.auditLog.findMany({ where: { createdAt: { gte: before }, entityType: "patients" } }));
    expect(rows.map((r) => [r.actorRole, r.supportSessionId])).toEqual([["SUPPORT", id]]);
    await endAll();
    expect(await allowChanges(admin(), id, new Date())).toEqual({ ok: false, code: "ALREADY_DECIDED", params: { status: "ENDED" } });
  });

  test("the database holds the rule: by the approver, never withdrawn, only while live, never at the start", async () => {
    const id = await live();
    await expect(sql("UPDATE support_sessions SET changes_allowed_at = now(), changes_allowed_by = $2 WHERE id = $1", [id, ids.otherAdmin])).rejects.toThrow("support_sessions_changes_allowed_by_approver");
    await sql("UPDATE support_sessions SET changes_allowed_at = now(), changes_allowed_by = approved_by WHERE id = $1", [id]);
    await expect(sql("UPDATE support_sessions SET changes_allowed_at = NULL, changes_allowed_by = NULL WHERE id = $1", [id])).rejects.toThrow("never withdrawn");
    await endAll();
    const ended = await live();
    await endAll();
    await expect(sql("UPDATE support_sessions SET changes_allowed_at = now(), changes_allowed_by = approved_by WHERE id = $1", [ended])).rejects.toThrow("only on a live session");
    await expect(sql(`INSERT INTO support_sessions (id, tenant_id, operator_id, requested_by, reason, status, approved_by, approved_at, expires_at, changes_allowed_at, changes_allowed_by)
      VALUES ($1, $2, $3, $4, 'x', 'ACTIVE', $4, now(), now() + interval '1 hour', now(), $4)`, [uuidv7(), clinic.tenantId, ids.operator, ids.admin])).rejects.toThrow("starts read-only");
  });

  test("a renewal starts read-only again", async () => {
    const id = await live();
    await allowChanges(admin(), id, new Date());
    const renewed = await changeSession(admin(), id, "renew", new Date());
    if (!renewed.ok) throw new Error("renewal refused");
    await expect(writePatient(renewed.value.id)).rejects.toThrow("read-only");
  });

  test("the hour's housekeeping under a read-only session is the system's, and does not refuse the read", async () => {
    const id = await live();
    const token = await supportToken(id);
    const lapsed = await live(ids.operator2);
    await sql("UPDATE support_sessions SET approved_at = now() - interval '2 hours', expires_at = now() - interval '1 hour' WHERE id = $1", [lapsed]);
    const before = await databaseNow();
    expect((await call(token, "GET", "/support-sessions/live")).status).toBe(200);
    const rows = await as((tx) => tx.auditLog.findMany({ where: { createdAt: { gte: before }, entityId: lapsed } }));
    expect(rows.map((r) => [r.actorRole, r.supportSessionId, (r.newState as { status: string }).status])).toEqual([["SYSTEM", null, "EXPIRED"]]);
  });

  test("after the housekeeping, the support binding is back: the next write in that transaction is stamped as support", async () => {
    const id = await live();
    await allowChanges(admin(), id, new Date());
    const lapsed = await live(ids.operator2);
    await sql("UPDATE support_sessions SET approved_at = now() - interval '2 hours', expires_at = now() - interval '1 hour' WHERE id = $1", [lapsed]);
    const before = await databaseNow();
    await withTenant(clinic.tenantId, { ...actorFor(ids.operator), supportSessionId: id }, async (tx) => {
      await settle(tx, clinic.tenantId, new Date());
      await tx.patient.update({ where: { id: clinic.patientId }, data: { notes: "after the housekeeping" } });
    });
    const rows = await as((tx) => tx.auditLog.findMany({ where: { createdAt: { gte: before }, entityType: { in: ["patients", "support_sessions"] } }, orderBy: { id: "asc" } }));
    expect(rows.map((r) => [r.entityType, r.actorRole, r.actorUserId, r.supportSessionId])).toEqual([
      ["support_sessions", "SYSTEM", "019b76da-a800-7000-8000-000000000001", null],
      ["patients", "SUPPORT", ids.operator, id],
    ]);
  });
});
