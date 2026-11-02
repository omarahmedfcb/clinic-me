// Support access PR 2 (docs/SUPPORT-ACCESS.md): sessions requested by the operator or opened by an admin, approved by an ACTIVE
// admin for exactly one hour, ended by anyone who sees the banner, expired lazily, ended at once when the switch goes off.
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { Client } from "pg";
import { uuidv7 } from "uuidv7";
import { AppModule } from "../../src/app.module.ts";
import { refusingValidationPipe } from "../../src/common/validation-pipe.ts";
import type { MembershipRole } from "../../src/generated/prisma/enums.ts";
import { issueAccessToken } from "../../src/modules/auth/jwt.ts";
import { issuePlatformToken } from "../../src/modules/platform/platform-token.ts";
import { listSessions } from "../../src/modules/support/support-sessions.ts";
import { injected } from "../../src/prisma/injected.ts";
import { type TransactionClient, withPlatformActor, withTenant } from "../../src/prisma/with-tenant.ts";
import { actorFor, createTestUser, deleteTestUser, makeOperator, seedClinic, teardownClinic, type ClinicFixture } from "./fixtures.ts";

describe("support sessions (support access PR 2)", () => {
  let app: NestExpressApplication;
  let baseUrl = "";
  let clinic: ClinicFixture;
  let dark: ClinicFixture;
  const users: string[] = [];
  const ids = { operator: "", second: "", admin: "" };
  const tokens = { operator: "", second: "", admin: "", reception: "", darkAdmin: "" };

  const as = <T>(work: (tx: TransactionClient) => Promise<T>): Promise<T> => withTenant(clinic.tenantId, actorFor(clinic.userId), work);
  const call = async (who: keyof typeof tokens, method: string, path: string, body?: unknown) => {
    const response = await fetch(`${baseUrl}${path}`, { method, headers: { authorization: `Bearer ${tokens[who]}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: (await response.json().catch(() => null)) as Record<string, unknown> };
  };
  const session = (id: string) => as((tx) => tx.supportSession.findUniqueOrThrow({ where: { id } }));
  async function member(target: ClinicFixture, role: MembershipRole): Promise<{ userId: string; token: string }> {
    const userId = await createTestUser();
    users.push(userId);
    const membershipId = randomUUID();
    await withTenant(target.tenantId, actorFor(target.userId), (tx) => tx.membership.create({ data: injected({ id: membershipId, userId, role, status: "ACTIVE" }) }));
    return { userId, token: await issueAccessToken({ sub: userId, membershipId, tenantId: target.tenantId, role }) };
  }
  async function operator(): Promise<{ userId: string; token: string }> {
    const userId = await createTestUser();
    users.push(userId);
    await makeOperator(userId);
    return { userId, token: await issuePlatformToken(userId, "full") };
  }
  const enable = async (target: ClinicFixture) => {
    const day = (offset: number) => new Date(Date.now() + offset * 86_400_000);
    await withPlatformActor(actorFor(ids.operator), async (tx) => {
      await tx.platformClinicContract.create({ data: { id: uuidv7(), tenantId: target.tenantId, fileName: "a.pdf", storageKey: `test/${uuidv7()}`, mimeType: "application/pdf", sizeBytes: 1,
        startsOn: day(-1), endsOn: day(365), dataProcessorClause: true, uploadedByUserId: ids.operator } });
      await tx.tenant.update({ where: { id: target.tenantId }, data: { supportAccessEnabled: true } });
    });
  };

  beforeAll(async () => {
    process.env["ATTACHMENTS_STORAGE_ROOT"] ??= process.cwd();
    clinic = await seedClinic();
    dark = await seedClinic();
    ({ userId: ids.operator, token: tokens.operator } = await operator());
    ({ userId: ids.second, token: tokens.second } = await operator());
    ({ userId: ids.admin, token: tokens.admin } = await member(clinic, "ADMIN"));
    tokens.reception = (await member(clinic, "RECEPTIONIST")).token;
    tokens.darkAdmin = (await member(dark, "ADMIN")).token;
    await enable(clinic);
    app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: false });
    app.useGlobalPipes(refusingValidationPipe());
    await app.listen(0);
    baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await app?.close();
    await teardownClinic(clinic);
    await teardownClinic(dark);
    for (const id of users) await deleteTestUser(id);
  });

  test("with the switch off, the feature is not there: the operator's request and the clinic's list are 404", async () => {
    expect((await call("operator", "POST", `/platform/support-sessions/clinics/${dark.tenantId}`, { reason: "slow day view" })).status).toBe(404);
    expect((await call("darkAdmin", "GET", "/support-sessions")).status).toBe(404);
  });

  test("the operator asks, the clinic's admins are told in-system, one open request at a time, and reception cannot approve", async () => {
    const asked = await call("operator", "POST", `/platform/support-sessions/clinics/${clinic.tenantId}`, { reason: "the day view is slow" });
    expect(asked.status).toBe(201);
    const id = String(asked.body["id"]);
    expect((await session(id)).status).toBe("REQUESTED");
    const told = await as((tx) => tx.operatorMessageRecipient.findMany({ where: { userId: ids.admin }, select: { body: true } }));
    expect(told.some((m) => m.body.includes("the day view is slow"))).toBe(true);
    expect((await call("operator", "POST", `/platform/support-sessions/clinics/${clinic.tenantId}`, { reason: "again" })).body).toMatchObject({ code: "ALREADY_IN_THAT_STATE" });
    expect((await call("reception", "POST", `/support-sessions/${id}/approve`)).status).toBe(403);
  });

  test("an admin approves: exactly one hour; every staff member sees it live, and reception may end it", async () => {
    const id = String(((await call("admin", "GET", "/support-sessions")).body["sessions"] as { id: string; status: string }[]).find((s) => s.status === "REQUESTED")!.id);
    expect((await call("admin", "POST", `/support-sessions/${id}/approve`)).body).toEqual({ id, status: "ACTIVE" });
    const live = await session(id);
    expect(live.expiresAt!.getTime() - live.approvedAt!.getTime()).toBe(60 * 60_000);
    expect(live.approvedBy).toBe(ids.admin);
    expect((await call("reception", "GET", "/support-sessions/live")).body["session"]).toMatchObject({ id });
    expect((await call("reception", "POST", `/support-sessions/${id}/end`, { reason: "I did not expect this" })).body).toEqual({ id, status: "ENDED" });
    expect((await session(id)).endReason).toBe("I did not expect this");
    expect((await call("reception", "GET", "/support-sessions/live")).body["session"]).toBeNull();
  });

  test("an admin opens one directly, renews it as a new linked row, and cannot open one for someone who is not an operator", async () => {
    const opened = await call("admin", "POST", "/support-sessions", { operatorId: ids.second, reason: "a printing fault" });
    expect(opened.status).toBe(201);
    const first = String(opened.body["id"]);
    const renewed = await call("admin", "POST", `/support-sessions/${first}/renew`);
    expect(renewed.body).toMatchObject({ status: "ACTIVE" });
    expect(await session(first)).toMatchObject({ status: "ENDED", endReason: "renewed" });
    expect(await session(String(renewed.body["id"]))).toMatchObject({ status: "ACTIVE", renewedFromId: first, operatorId: ids.second });
    expect((await call("admin", "POST", "/support-sessions", { operatorId: clinic.userId, reason: "x" })).body).toMatchObject({ code: "INVALID_FIELD", params: { field: "operatorId" } });
  });

  test("past its hour a session reads as EXPIRED, without anyone ending it", async () => {
    const live = (await as((tx) => tx.supportSession.findFirstOrThrow({ where: { status: "ACTIVE" } })));
    const later = new Date(live.expiresAt!.getTime() + 1_000);
    const listed = await listSessions({ tenantId: clinic.tenantId, actor: actorFor(ids.admin) }, later);
    expect(listed!.find((s) => s.id === live.id)).toMatchObject({ status: "EXPIRED", endReason: "the hour ended" });
  });

  test("the database refuses an approver who is not an admin, and any hour that is not one hour", async () => {
    const asked = await call("operator", "POST", `/platform/support-sessions/clinics/${clinic.tenantId}`, { reason: "check" });
    const id = String(asked.body["id"]);
    const now = new Date();
    const tried = (data: Record<string, unknown>) => as((tx) => tx.supportSession.update({ where: { id }, data })).then(() => "no error", (e: Error) => e.message);
    expect(await tried({ status: "ACTIVE", approvedBy: clinic.userId, approvedAt: now, expiresAt: new Date(now.getTime() + 3_600_000) })).toContain("approved by an active admin");
    expect(await tried({ status: "ACTIVE", approvedBy: ids.admin, approvedAt: now, expiresAt: new Date(now.getTime() + 7_200_000) })).toContain("support_sessions_one_hour");
  });

  test("switching support off ends the live session and closes the open request at once", async () => {
    expect((await call("admin", "POST", "/support-sessions", { operatorId: ids.second, reason: "a live one" })).status).toBe(201);
    expect(await as((tx) => tx.supportSession.count({ where: { status: "REQUESTED" } }))).toBe(1);
    await withPlatformActor(actorFor(ids.operator), (tx) => tx.tenant.update({ where: { id: clinic.tenantId }, data: { supportAccessEnabled: false } }));
    expect(await as((tx) => tx.supportSession.count({ where: { status: { in: ["REQUESTED", "ACTIVE"] } } }))).toBe(0);
    const closed = await as((tx) => tx.supportSession.findMany({ where: { endReason: "support access switched off" }, select: { status: true } }));
    expect(closed.map((s) => s.status).sort()).toEqual(["DENIED", "ENDED"]);
  });

  test("AccessGrant is gone", async () => {
    const owner = new Client({ connectionString: process.env["TEST_OBSERVER_URL"] ?? process.env["DATABASE_URL"] ?? "" });
    await owner.connect();
    try {
      expect((await owner.query("SELECT to_regclass('public.access_grants') AS t")).rows[0].t).toBeNull();
    } finally {
      await owner.end();
    }
  });
});
