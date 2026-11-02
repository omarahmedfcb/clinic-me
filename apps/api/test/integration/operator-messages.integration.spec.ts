// Branches step 6.4 (§9 D): the operator messages one clinic's admins or every clinic's, in-system only. Admins only, never
// staff; each admin reads only their own copy; reads are counted once; messages, copies and reads are append-only.
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { Client } from "pg";
import { AppModule } from "../../src/app.module.ts";
import { refusingValidationPipe } from "../../src/common/validation-pipe.ts";
import type { MembershipRole } from "../../src/generated/prisma/enums.ts";
import { issueAccessToken } from "../../src/modules/auth/jwt.ts";
import { issuePlatformToken } from "../../src/modules/platform/platform-token.ts";
import { injected } from "../../src/prisma/injected.ts";
import { withTenant } from "../../src/prisma/with-tenant.ts";
import { actorFor, createTestUser, deleteTestUser, makeOperator, seedClinic, teardownClinic, type ClinicFixture } from "./fixtures.ts";

describe("operator messages (step 6.4)", () => {
  let app: NestExpressApplication;
  let baseUrl = "";
  let a: ClinicFixture;
  let b: ClinicFixture;
  let operatorId = "";
  const users: string[] = [];
  const tokens = { operator: "", adminA: "", secondAdminA: "", receptionA: "", adminB: "" };

  async function member(clinic: ClinicFixture, role: MembershipRole): Promise<string> {
    const userId = await createTestUser();
    users.push(userId);
    const membershipId = randomUUID();
    await withTenant(clinic.tenantId, actorFor(clinic.userId), (tx) => tx.membership.create({ data: injected({ id: membershipId, userId, role, status: "ACTIVE" }) }));
    return issueAccessToken({ sub: userId, membershipId, tenantId: clinic.tenantId, role });
  }
  const call = async (who: keyof typeof tokens, method: string, path: string, body?: unknown) => {
    const response = await fetch(`${baseUrl}${path}`, { method, headers: { authorization: `Bearer ${tokens[who]}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: (await response.json().catch(() => null)) as Record<string, unknown> };
  };
  const inbox = async (who: keyof typeof tokens) => ((await call(who, "GET", "/operator-messages")).body["messages"] as { id: string; body: string; readAt: string | null }[]);

  beforeAll(async () => {
    process.env["ATTACHMENTS_STORAGE_ROOT"] ??= process.cwd();
    a = await seedClinic();
    b = await seedClinic();
    tokens.adminA = await member(a, "ADMIN");
    tokens.secondAdminA = await member(a, "OWNER");
    tokens.receptionA = await member(a, "RECEPTIONIST");
    tokens.adminB = await member(b, "ADMIN");
    operatorId = await createTestUser();
    await makeOperator(operatorId);
    tokens.operator = await issuePlatformToken(operatorId, "full");
    app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: false });
    app.useGlobalPipes(refusingValidationPipe());
    await app.listen(0);
    baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await app?.close();
    await teardownClinic(a);
    await teardownClinic(b);
    for (const id of [...users, operatorId]) await deleteTestUser(id);
  });

  test("a message to one clinic reaches its admins and owner only, never staff and never another clinic", async () => {
    const sent = await call("operator", "POST", "/platform/messages", { tenantId: a.tenantId, body: "Maintenance tonight at 02:00." });
    expect(sent).toMatchObject({ status: 201, body: { clinics: 1, recipients: 2 } });
    expect((await inbox("adminA")).map((m) => m.body)).toEqual(["Maintenance tonight at 02:00."]);
    expect((await inbox("secondAdminA")).map((m) => m.body)).toEqual(["Maintenance tonight at 02:00."]);
    expect((await call("receptionA", "GET", "/operator-messages")).status).toBe(403);
    expect(await inbox("adminB")).toEqual([]);
  });

  test("a read is counted once, the unread count follows it, and nobody marks another admin's copy", async () => {
    const [mine] = await inbox("adminA");
    expect((await call("adminA", "GET", "/operator-messages/unread")).body).toEqual({ unread: 1 });
    expect((await call("adminA", "POST", `/operator-messages/${mine!.id}/read`)).status).toBe(200);
    expect((await call("adminA", "POST", `/operator-messages/${mine!.id}/read`)).status).toBe(200);
    expect((await call("adminA", "GET", "/operator-messages/unread")).body).toEqual({ unread: 0 });
    expect((await inbox("adminA"))[0]!.readAt).not.toBeNull();
    expect((await call("secondAdminA", "POST", `/operator-messages/${mine!.id}/read`)).status).toBe(404);
    expect((await call("secondAdminA", "GET", "/operator-messages/unread")).body).toEqual({ unread: 1 });
  });

  test("a message to every clinic reaches both, and the operator's history counts recipients and reads", async () => {
    const sent = await call("operator", "POST", "/platform/messages", { body: "New feature: branch reports." });
    expect(sent.status).toBe(201);
    expect((await inbox("adminB")).map((m) => m.body)).toEqual(["New feature: branch reports."]);
    expect((await inbox("adminA")).map((m) => m.body)).toEqual(["New feature: branch reports.", "Maintenance tonight at 02:00."]);
    const history = (await call("operator", "GET", "/platform/messages")).body["messages"] as Record<string, unknown>[];
    expect(history.find((m) => m["body"] === "Maintenance tonight at 02:00.")).toMatchObject({ audience: "ONE_CLINIC", targetTenantId: a.tenantId, clinics: 1, recipients: 2, reads: 1 });
    expect(history.find((m) => m["id"] === sent.body["id"])).toMatchObject({ audience: "ALL_CLINICS", targetTenantId: null });
  });

  test("refusals: an unknown clinic, a blank or oversized body, a clinic token on the operator's route", async () => {
    expect((await call("operator", "POST", "/platform/messages", { tenantId: randomUUID(), body: "x" })).status).toBe(404);
    expect((await call("operator", "POST", "/platform/messages", { tenantId: a.tenantId, body: "   " })).status).toBe(400);
    expect((await call("operator", "POST", "/platform/messages", { tenantId: a.tenantId, body: "x".repeat(4001) })).status).toBe(400);
    expect((await call("adminA", "POST", "/platform/messages", { body: "x" })).status).toBe(401);
  });

  test("records are append-only, and a clinic session cannot read the vendor's record of what was sent", async () => {
    expect(await withTenant(a.tenantId, actorFor(a.userId), (tx) => tx.operatorMessage.count())).toBe(0);
    const owner = new Client({ connectionString: process.env["TEST_OBSERVER_URL"] ?? process.env["DATABASE_URL"] ?? "" });
    await owner.connect();
    try {
      const tried = async (sql: string) => owner.query(sql, [a.tenantId]).then(() => "no error", (e: Error) => e.message);
      expect(await tried("UPDATE operator_message_recipients SET body = 'edited' WHERE tenant_id = $1")).toContain("append-only");
      expect(await tried("DELETE FROM operator_message_reads WHERE tenant_id = $1")).toContain("append-only");
      expect(await tried("DELETE FROM operator_messages WHERE target_tenant_id = $1")).toContain("append-only");
    } finally {
      await owner.end();
    }
  });
});
