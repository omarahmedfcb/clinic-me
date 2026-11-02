// Branches step 6.2 (§1.4, §9 A): a clinic asks to raise its branch limit, one pending at a time; the operator's queue
// reads across clinics; an approval raises the limit through 6.1's path and names that change, a rejection says why.
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { AppModule } from "../../src/app.module.ts";
import { refusingValidationPipe } from "../../src/common/validation-pipe.ts";
import type { MembershipRole } from "../../src/generated/prisma/enums.ts";
import { issueAccessToken } from "../../src/modules/auth/jwt.ts";
import { issuePlatformToken } from "../../src/modules/platform/platform-token.ts";
import { injected } from "../../src/prisma/injected.ts";
import { type TransactionClient, withPlatformActor, withTenant } from "../../src/prisma/with-tenant.ts";
import { actorFor, createTestUser, deleteTestUser, makeOperator, seedClinic, teardownClinic, type ClinicFixture } from "./fixtures.ts";

describe("the request to raise the branch limit (step 6.2)", () => {
  let app: NestExpressApplication;
  let baseUrl = "";
  let clinic: ClinicFixture;
  let operatorId = "";
  const users: string[] = [];
  const tokens = { admin: "", reception: "", operator: "" };

  const as = <T>(work: (tx: TransactionClient) => Promise<T>): Promise<T> => withTenant(clinic.tenantId, actorFor(clinic.userId), work);
  const call = async (who: keyof typeof tokens, method: string, path: string, body?: unknown) => {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { authorization: `Bearer ${tokens[who]}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: (await response.json().catch(() => null)) as Record<string, unknown> };
  };
  const ask = (requestedLimit: number) => call("admin", "POST", "/branch-requests", { requestedLimit, note: "a second site" });
  const decide = (id: string, body: unknown) => call("operator", "POST", `/platform/branch-requests/${id}/decision`, body);
  const limit = async () => (await as((tx) => tx.tenant.findUniqueOrThrow({ where: { id: clinic.tenantId }, select: { maxBranches: true } }))).maxBranches;
  async function member(role: MembershipRole): Promise<string> {
    const userId = await createTestUser();
    users.push(userId);
    const membershipId = randomUUID();
    await as((tx) => tx.membership.create({ data: injected({ id: membershipId, userId, role, status: "ACTIVE" }) }));
    return issueAccessToken({ sub: userId, membershipId, tenantId: clinic.tenantId, role });
  }

  beforeAll(async () => {
    process.env["ATTACHMENTS_STORAGE_ROOT"] ??= process.cwd();
    clinic = await seedClinic();
    await as((tx) => tx.tenant.update({ where: { id: clinic.tenantId }, data: { maxBranches: 1 } }));
    tokens.admin = await member("ADMIN");
    tokens.reception = await member("RECEPTIONIST");
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
    await teardownClinic(clinic);
    for (const id of [...users, operatorId]) await deleteTestUser(id);
  });

  test("the clinic asks; one pending at a time; not at or below its limit; not from reception", async () => {
    const asked = await ask(3);
    expect(asked).toMatchObject({ status: 201, body: { requestedLimit: 3, status: "PENDING", note: "a second site" } });
    expect((await ask(4)).body).toMatchObject({ code: "ALREADY_IN_THAT_STATE", params: { status: "PENDING" } });
    expect((await call("reception", "POST", "/branch-requests", { requestedLimit: 3 })).status).toBe(403);
    await call("admin", "POST", `/branch-requests/${String(asked.body["id"])}/withdraw`);
    expect((await ask(1 + 0)).status).toBe(400);
    await as((tx) => tx.tenant.update({ where: { id: clinic.tenantId }, data: { maxBranches: 2 } }));
    expect((await ask(2)).body).toMatchObject({ code: "INVALID_FIELD", params: { field: "requestedLimit" } });
    await as((tx) => tx.tenant.update({ where: { id: clinic.tenantId }, data: { maxBranches: 1 } }));
  });

  test("the operator's queue reads across clinics, with the clinic's name, its limit and its active branches", async () => {
    const asked = await ask(3);
    const queue = (await call("operator", "GET", "/platform/branch-requests")).body["requests"] as Record<string, unknown>[];
    expect(queue.find((r) => r["id"] === asked.body["id"])).toMatchObject({ tenantId: clinic.tenantId, status: "PENDING", requestedLimit: 3, currentLimit: 1, activeBranches: 1 });
    expect((await call("admin", "GET", "/platform/branch-requests")).status).toBe(401);
    const refused = await withPlatformActor(actorFor(clinic.userId), (tx) => tx.$queryRaw`SELECT * FROM platform_branch_requests()`).then(() => "no error", (e: Error) => e.message);
    expect(refused).toContain("is not an active platform admin");
  });

  test("a rejection needs a reason and is final; the clinic sees why", async () => {
    const id = String(((await call("admin", "GET", "/branch-requests")).body["requests"] as Record<string, unknown>[])[0]!["id"]);
    expect((await decide(id, { approve: false })).body).toMatchObject({ code: "REASON_REQUIRED" });
    expect((await decide(id, { approve: false, reason: "add-on not purchased" })).body).toMatchObject({ status: "REJECTED", maxBranches: 1 });
    expect((await decide(id, { approve: true })).body).toMatchObject({ code: "ALREADY_DECIDED", params: { status: "REJECTED" } });
    const mine = (await call("admin", "GET", "/branch-requests")).body;
    expect(mine["maxBranches"]).toBe(1);
    expect((mine["requests"] as Record<string, unknown>[])[0]).toMatchObject({ status: "REJECTED", decisionReason: "add-on not purchased" });
  });

  test("an approval raises the limit through the history, names that change, and lands in the clinic's trail", async () => {
    const id = String((await ask(3)).body["id"]);
    expect((await decide(id, { approve: true, reason: "add-on signed" })).body).toMatchObject({ status: "APPROVED", maxBranches: 3 });
    expect(await limit()).toBe(3);
    const request = await as((tx) => tx.branchRequest.findUniqueOrThrow({ where: { id }, select: { limitChangeId: true, limitChange: { select: { previousLimit: true, newLimit: true, changedBy: true } } } }));
    expect(request.limitChange).toEqual({ previousLimit: 1, newLimit: 3, changedBy: operatorId });
    const trail = await as((tx) => tx.auditLog.count({ where: { entityType: "branch_requests", entityId: id, actorUserId: operatorId } }));
    expect(trail).toBeGreaterThan(0);
  });

  test("an approval never lowers a limit the operator has already raised past the request", async () => {
    const id = String((await ask(5)).body["id"]);
    await as((tx) => tx.tenant.update({ where: { id: clinic.tenantId }, data: { maxBranches: 6 } }));
    expect((await decide(id, { approve: true })).body).toMatchObject({ code: "ALREADY_IN_THAT_STATE", params: { status: "6" } });
    expect(await limit()).toBe(6);
  });
});
