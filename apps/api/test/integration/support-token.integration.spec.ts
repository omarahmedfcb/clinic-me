// Support access PR 3 (docs/SUPPORT-ACCESS.md §8 risk 1): the support token, the per-request check, and expiry in three layers:
// the guard needs 30 s left, each transaction re-checks and is timed out at the session's end, the trigger refuses a late write.
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { SignJWT } from "jose";
import { Client } from "pg";
import { uuidv7 } from "uuidv7";
import { AppModule } from "../../src/app.module.ts";
import { SUPPORT_MARGIN_SECONDS } from "../../src/common/membership-freshness.interceptor.ts";
import { refusingValidationPipe } from "../../src/common/validation-pipe.ts";
import { issueAccessToken, verifyAccessToken } from "../../src/modules/auth/jwt.ts";
import { issuePlatformToken } from "../../src/modules/platform/platform-token.ts";
import { allowChanges, openSession } from "../../src/modules/support/support-sessions.ts";
import { prisma } from "../../src/prisma/client.ts";
import { injected } from "../../src/prisma/injected.ts";
import { SupportSessionEndedError, type TransactionClient, withPlatformActor, withTenant } from "../../src/prisma/with-tenant.ts";
import { actorFor, createTestUser, deleteTestUser, makeOperator, seedClinic, teardownClinic, type ClinicFixture } from "./fixtures.ts";

describe("the support token and its three expiry layers (support access PR 3)", () => {
  let app: NestExpressApplication;
  let baseUrl = "";
  let clinic: ClinicFixture;
  const users: string[] = [];
  const ids = { operator: "", other: "", admin: "", adminMembership: "" };
  const tokens = { operator: "", other: "", reception: "" };

  const as = <T>(work: (tx: TransactionClient) => Promise<T>): Promise<T> => withTenant(clinic.tenantId, actorFor(clinic.userId), work);
  const owner = () => new Client({ connectionString: process.env["TEST_OBSERVER_URL"] ?? process.env["DATABASE_URL"] ?? "" });
  const sql = async (text: string, params: unknown[] = []) => {
    const c = owner();
    await c.connect();
    try {
      await c.query("BEGIN");
      await c.query("SELECT set_config('app.current_actor_id', system_actor_id()::text, true)");
      const rows = (await c.query(text, params)).rows;
      await c.query("COMMIT");
      return rows;
    } finally {
      await c.end();
    }
  };
  const get = (token: string, path: string) => fetch(`${baseUrl}${path}`, { headers: { authorization: `Bearer ${token}` } }).then((r) => r.status);
  const live = async () => (await openSession({ tenantId: clinic.tenantId, actor: actorFor(ids.admin) }, { operatorId: ids.operator, reason: "diagnosis" }, new Date()) as { ok: true; value: { id: string } }).value.id;
  const supportToken = async (sessionId: string) => {
    const r = await fetch(`${baseUrl}/platform/support-sessions/clinics/${clinic.tenantId}/${sessionId}/token`, { method: "POST", headers: { authorization: `Bearer ${tokens.operator}` } });
    return { status: r.status, token: ((await r.json()) as { token?: string }).token ?? "" };
  };
  // Through the application's own role, the one granted EXECUTE: the owner connection, in the RLS drill, is not.
  const resolve = async (sessionId: string, margin: number) =>
    (await prisma.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM resolve_live_support_session(${sessionId}::uuid, ${ids.operator}::uuid, ${ids.adminMembership}::uuid, ${margin}::int)`)[0]!.n;
  const endAll = () => as((tx) => tx.supportSession.updateMany({ where: { status: "ACTIVE" }, data: { status: "ENDED", endedAt: new Date(), endReason: "test" } }));
  const supportActor = (sessionId: string) => ({ ...actorFor(ids.operator), supportSessionId: sessionId });

  beforeAll(async () => {
    process.env["ATTACHMENTS_STORAGE_ROOT"] ??= process.cwd();
    clinic = await seedClinic();
    for (const key of ["operator", "other"] as const) {
      ids[key] = await createTestUser();
      users.push(ids[key]);
      await makeOperator(ids[key]);
      tokens[key] = await issuePlatformToken(ids[key], "full");
    }
    ids.admin = await createTestUser();
    users.push(ids.admin);
    ids.adminMembership = randomUUID();
    await as((tx) => tx.membership.create({ data: injected({ id: ids.adminMembership, userId: ids.admin, role: "ADMIN", status: "ACTIVE" }) }));
    const owner2 = await createTestUser();
    users.push(owner2);
    await as((tx) => tx.membership.create({ data: injected({ id: randomUUID(), userId: owner2, role: "OWNER", status: "ACTIVE" }) }));
    const receptionist = await createTestUser();
    users.push(receptionist);
    const receptionMembership = randomUUID();
    await as((tx) => tx.membership.create({ data: injected({ id: receptionMembership, userId: receptionist, role: "RECEPTIONIST", status: "ACTIVE" }) }));
    tokens.reception = await issueAccessToken({ sub: receptionist, membershipId: receptionMembership, tenantId: clinic.tenantId, role: "RECEPTIONIST" });
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

  test("a token is issued only for the operator's own live session, and opens the clinic as the approving admin sees it", async () => {
    const id = await live();
    const issued = await supportToken(id);
    expect(issued.status).toBe(200);
    expect((await fetch(`${baseUrl}/platform/support-sessions/clinics/${clinic.tenantId}/${id}/token`, { method: "POST", headers: { authorization: `Bearer ${tokens.other}` } })).status).toBe(404);
    expect((await supportToken(randomUUID())).status).toBe(404);
    expect(await get(issued.token, "/support-sessions/live")).toBe(200);
    const claims = await verifyAccessToken(issued.token);
    expect(claims).toMatchObject({ sub: ids.operator, membershipId: ids.adminMembership, tenantId: clinic.tenantId, role: "ADMIN", supportSessionId: id });
  });

  test("a support session id is never accepted on an ordinary token, nor an audience on one", async () => {
    const secret = new TextEncoder().encode(process.env["JWT_SECRET"]);
    const forge = (extra: Record<string, unknown>, aud?: string) => {
      const jwt = new SignJWT({ membershipId: ids.adminMembership, tenantId: clinic.tenantId, role: "ADMIN", ...extra }).setProtectedHeader({ alg: "HS256" }).setSubject(ids.operator).setIssuedAt().setExpirationTime("5m");
      return (aud === undefined ? jwt : jwt.setAudience(aud)).sign(secret);
    };
    await expect(verifyAccessToken(await forge({ supportSessionId: randomUUID() }))).rejects.toThrow("invalid");
    await expect(verifyAccessToken(await forge({}, "somewhere-else"))).rejects.toThrow("invalid");
  });

  test("the next request after the clinic ends the session is refused", async () => {
    const id = await live();
    const { token } = await supportToken(id);
    expect(await get(token, "/support-sessions/live")).toBe(200);
    await fetch(`${baseUrl}/support-sessions/${id}/end`, { method: "POST", headers: { authorization: `Bearer ${tokens.reception}`, "content-type": "application/json" }, body: "{}" });
    expect(await get(token, "/support-sessions/live")).toBe(401);
  });

  test("layer 1: no request starts with less than 30 seconds left", async () => {
    const id = await live();
    const { token } = await supportToken(id);
    await sql("UPDATE support_sessions SET approved_at = now() - interval '59 minutes 40 seconds', expires_at = now() + interval '20 seconds' WHERE id = $1", [id]);
    expect(await get(token, "/support-sessions/live")).toBe(401);
    // The guard's own layer, apart from the transaction's: the resolver it calls refuses at 20 s left with its margin.
    expect(await resolve(id, SUPPORT_MARGIN_SECONDS)).toBe(0);
    expect(await resolve(id, 0)).toBe(1);
  });

  test("every fact the session rests on is re-checked: the approver demoted, the operator's account locked", async () => {
    const id = await live();
    const { token } = await supportToken(id);
    await sql("UPDATE memberships SET role = 'RECEPTIONIST' WHERE id = $1", [ids.adminMembership]);
    expect(await get(token, "/support-sessions/live")).toBe(401);
    expect(await resolve(id, SUPPORT_MARGIN_SECONDS)).toBe(0);
    await sql("UPDATE memberships SET role = 'ADMIN' WHERE id = $1", [ids.adminMembership]);
    expect(await get(token, "/support-sessions/live")).toBe(200);
    await sql("UPDATE users SET status = 'LOCKED' WHERE id = $1", [ids.operator]);
    expect(await get(token, "/support-sessions/live")).toBe(401);
    await sql("UPDATE users SET status = 'ACTIVE' WHERE id = $1", [ids.operator]);
  });

  test("layer 2: each transaction re-checks the session and cannot run a statement past its end", async () => {
    const id = await live();
    const timeout = await withTenant(clinic.tenantId, supportActor(id), (tx) => tx.$queryRaw<{ ms: number }[]>`SELECT setting::int AS ms FROM pg_settings WHERE name = 'statement_timeout'`);
    expect(timeout[0]!.ms).toBeGreaterThan(3_500_000);
    expect(timeout[0]!.ms).toBeLessThanOrEqual(3_600_000);
    await endAll();
    await expect(withTenant(clinic.tenantId, supportActor(id), async () => "ran")).rejects.toBeInstanceOf(SupportSessionEndedError);
  });

  test("layer 3: the database refuses a write under a session that is not live, even with the application bypassed", async () => {
    const id = await live();
    await allowChanges({ tenantId: clinic.tenantId, actor: actorFor(ids.admin) }, id, new Date());
    const write = async () => {
      const c = owner();
      await c.connect();
      try {
        await c.query("BEGIN");
        await c.query("SELECT set_config('app.current_tenant_id', $1, true), set_config('app.current_actor_id', $2, true), set_config('app.current_support_session_id', $3, true)", [clinic.tenantId, ids.operator, id]);
        await c.query("UPDATE patients SET notes = 'support wrote this' WHERE id = $1", [clinic.patientId]);
        return "written";
      } catch (e) {
        return (e as Error).message;
      } finally {
        await c.query("ROLLBACK").catch(() => undefined);
        await c.end();
      }
    };
    expect(await write()).toBe("written");
    await endAll();
    expect(await write()).toContain("is not live");
  });
});
