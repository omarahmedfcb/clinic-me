// Branches step 6.3 (§9 A; ruled 2026-10-30 and 2026-10-31): a lowered limit opens 30 days' grace, the admin chooses, the
// pass then suspends the excess, never a branch with a future booking (deferred, and the operator sees it), and never deletes.
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { AppModule } from "../../src/app.module.ts";
import { refusingValidationPipe } from "../../src/common/validation-pipe.ts";
import { issueAccessToken } from "../../src/modules/auth/jwt.ts";
import { enforceBranchLimits, GRACE_DAYS } from "../../src/modules/branches/branch-limit-grace.ts";
import { setBranchLimit } from "../../src/modules/platform/platform-branch-limit.ts";
import { issuePlatformToken } from "../../src/modules/platform/platform-token.ts";
import { injected } from "../../src/prisma/injected.ts";
import { type TransactionClient, withTenant } from "../../src/prisma/with-tenant.ts";
import { actorFor, createTestUser, deleteTestUser, makeOperator, seedClinic, teardownClinic, type ClinicFixture } from "./fixtures.ts";

describe("a lowered branch limit (step 6.3)", () => {
  let app: NestExpressApplication;
  let baseUrl = "";
  let operatorId = "";
  let operatorToken = "";
  const clinics: ClinicFixture[] = [];
  const users: string[] = [];

  const as = <T>(clinic: ClinicFixture, work: (tx: TransactionClient) => Promise<T>): Promise<T> => withTenant(clinic.tenantId, actorFor(clinic.userId), work);
  async function clinicWithBranches(names: string[]): Promise<{ clinic: ClinicFixture; ids: string[]; admin: string }> {
    const clinic = await seedClinic();
    clinics.push(clinic);
    const ids: string[] = [];
    for (const name of names) {
      const id = randomUUID();
      await as(clinic, (tx) => tx.branch.create({ data: injected({ id, name, address: "Giza", phone: "+201000000001", receiptPrefix: name, invoicePrefix: name }) }));
      ids.push(id);
    }
    const userId = await createTestUser();
    users.push(userId);
    const membershipId = randomUUID();
    await as(clinic, (tx) => tx.membership.create({ data: injected({ id: membershipId, userId, role: "ADMIN", status: "ACTIVE" }) }));
    return { clinic, ids, admin: await issueAccessToken({ sub: userId, membershipId, tenantId: clinic.tenantId, role: "ADMIN" }) };
  }
  const lower = (clinic: ClinicFixture, maxBranches: number) => setBranchLimit(actorFor(operatorId), clinic.tenantId, { maxBranches, reason: "add-on cancelled" });
  const grace = (clinic: ClinicFixture) => as(clinic, (tx) => tx.branchLimitGrace.findFirstOrThrow({ orderBy: { startedAt: "desc" } }));
  const statusOf = async (clinic: ClinicFixture) =>
    Object.fromEntries((await as(clinic, (tx) => tx.branch.findMany({ select: { name: true, status: true } }))).map((b) => [b.name, b.status]));
  const bookIn = (clinic: ClinicFixture, branchId: string, start: Date) => {
    const id = randomUUID();
    return as(clinic, (tx) => tx.appointment.create({ data: injected({ id, branchId, patientId: clinic.patientId, doctorId: clinic.doctorId, serviceId: clinic.serviceId,
      scheduledStart: start, scheduledEnd: new Date(start.getTime() + 15 * 60_000), status: "BOOKED", source: "RECEPTION", createdBy: clinic.userId, updatedBy: clinic.userId }) })).then(() => id);
  };
  const call = async (token: string, method: string, path: string, body?: unknown) => {
    const response = await fetch(`${baseUrl}${path}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: (await response.json().catch(() => null)) as Record<string, unknown> };
  };
  const mine = (outcomes: Awaited<ReturnType<typeof enforceBranchLimits>>, clinic: ClinicFixture) => outcomes.find((o) => o.tenantId === clinic.tenantId);

  beforeAll(async () => {
    process.env["ATTACHMENTS_STORAGE_ROOT"] ??= process.cwd();
    operatorId = await createTestUser();
    await makeOperator(operatorId);
    operatorToken = await issuePlatformToken(operatorId, "full");
    app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: false });
    app.useGlobalPipes(refusingValidationPipe());
    await app.listen(0);
    baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await app?.close();
    for (const clinic of clinics) await teardownClinic(clinic);
    for (const id of [...users, operatorId]) await deleteTestUser(id);
  });

  test("the admin's choice is honoured, and a branch with a future booking is never suspended: deferred, and the operator sees it", async () => {
    const { clinic, ids: [b, c], admin } = await clinicWithBranches(["B", "C"]);
    expect(await lower(clinic, 1)).toMatchObject({ ok: true });
    const opened = await grace(clinic);
    expect(opened.status).toBe("OPEN");
    expect(opened.endsAt.getTime() - opened.startedAt.getTime()).toBe(GRACE_DAYS * 86_400_000);
    expect(await statusOf(clinic)).toMatchObject({ B: "ACTIVE", C: "ACTIVE" });

    const status = (await call(admin, "GET", "/branch-limit")).body;
    expect(status).toMatchObject({ maxBranches: 1, activeBranches: 3, excess: 2, grace: { status: "OPEN", chosen: [] } });
    const defaultBranch = clinic.branchId;
    expect((await call(admin, "PUT", "/branch-limit/choice", { branchIds: [b] })).body).toMatchObject({ code: "INVALID_FIELD", params: { field: "branchIds" } });
    expect((await call(admin, "PUT", "/branch-limit/choice", { branchIds: [b, defaultBranch] })).body).toMatchObject({ code: "INVALID_FIELD" });
    expect((await call(admin, "PUT", "/branch-limit/choice", { branchIds: [b, c] })).body).toEqual({ chosen: [b, c] });

    expect(mine(await enforceBranchLimits(new Date(opened.endsAt.getTime() - 60_000)), clinic)).toBeUndefined();
    const booking = await bookIn(clinic, c!, new Date(opened.endsAt.getTime() + 86_400_000));
    const atDeadline = new Date(opened.endsAt.getTime() + 60_000);
    expect(mine(await enforceBranchLimits(atDeadline), clinic)).toEqual({ tenantId: clinic.tenantId, status: "DEFERRED", suspended: [b], deferred: [c] });
    expect(await statusOf(clinic)).toMatchObject({ B: "SUSPENDED", C: "ACTIVE" });
    const deferred = await grace(clinic);
    expect(deferred).toMatchObject({ status: "DEFERRED", deferredReason: "future bookings in C (1)" });
    const operatorView = ((await call(operatorToken, "GET", "/platform/branch-limit-graces")).body["graces"] as Record<string, unknown>[]).find((g) => g["tenantId"] === clinic.tenantId);
    expect(operatorView).toMatchObject({ status: "DEFERRED", deferredReason: "future bookings in C (1)", currentLimit: 1, activeBranches: 2 });

    await as(clinic, (tx) => tx.appointment.update({ where: { id: booking }, data: { status: "CANCELLED" } }));
    expect(mine(await enforceBranchLimits(new Date(atDeadline.getTime() + 86_400_000)), clinic)).toMatchObject({ status: "DONE", suspended: [c] });
    expect(await statusOf(clinic)).toMatchObject({ B: "SUSPENDED", C: "SUSPENDED" });
    expect(await as(clinic, (tx) => tx.branch.count())).toBe(3);
    expect(await as(clinic, (tx) => tx.appointment.count({ where: { id: booking } }))).toBe(1);
  });

  test("a choice of the older branch is honoured over the newest-first rule", async () => {
    const { clinic, ids: [older], admin } = await clinicWithBranches(["M", "N"]);
    await lower(clinic, 2);
    expect((await call(admin, "PUT", "/branch-limit/choice", { branchIds: [older] })).status).toBe(200);
    const opened = await grace(clinic);
    expect(mine(await enforceBranchLimits(new Date(opened.endsAt.getTime() + 60_000)), clinic)).toMatchObject({ status: "DONE", suspended: [older] });
    expect(await statusOf(clinic)).toMatchObject({ M: "SUSPENDED", N: "ACTIVE" });
  });

  test("with no choice made, the newest branches go first, never the default branch", async () => {
    const { clinic } = await clinicWithBranches(["P", "Q"]);
    await lower(clinic, 2);
    const opened = await grace(clinic);
    expect(mine(await enforceBranchLimits(new Date(opened.endsAt.getTime() + 60_000)), clinic)).toMatchObject({ status: "DONE" });
    expect(await statusOf(clinic)).toMatchObject({ P: "ACTIVE", Q: "SUSPENDED" });
  });

  test("raising the limit during the grace clears it, and nothing is suspended", async () => {
    const { clinic } = await clinicWithBranches(["X"]);
    await lower(clinic, 1);
    expect((await grace(clinic)).status).toBe("OPEN");
    await setBranchLimit(actorFor(operatorId), clinic.tenantId, { maxBranches: 2, reason: "add-on renewed" });
    const cleared = await grace(clinic);
    expect(cleared.status).toBe("CLEARED");
    expect(mine(await enforceBranchLimits(new Date(cleared.endsAt.getTime() + 60_000)), clinic)).toBeUndefined();
    expect(await statusOf(clinic)).toMatchObject({ X: "ACTIVE" });
  });
});
