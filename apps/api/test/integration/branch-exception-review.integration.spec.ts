// Branches step 6.6 (§4.4): creating a branch puts every future-dated exception to the clinic, not only the every-branch
// ones; KEEP leaves it, COPY_TO_NEW_BRANCH adds it to the new branch through the schedules rules; a decision is final.
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { AppModule } from "../../src/app.module.ts";
import { todayInClinic } from "../../src/common/clinic-time.ts";
import { refusingValidationPipe } from "../../src/common/validation-pipe.ts";
import type { MembershipRole } from "../../src/generated/prisma/enums.ts";
import { issueAccessToken } from "../../src/modules/auth/jwt.ts";
import { openExceptionReview } from "../../src/modules/branches/exception-review.ts";
import { injected } from "../../src/prisma/injected.ts";
import { type TransactionClient, withTenant } from "../../src/prisma/with-tenant.ts";
import { actorFor, createTestUser, deleteTestUser, seedClinic, teardownClinic, type ClinicFixture } from "./fixtures.ts";

describe("the review of future-dated exceptions when a branch is created (step 6.6)", () => {
  let app: NestExpressApplication;
  let baseUrl = "";
  let clinic: ClinicFixture;
  let branchB = "";
  let opened = 0;
  const users: string[] = [];
  const tokens = { admin: "", reception: "" };
  const ids = { inA: "", everyBranch: "", clinicWide: "", past: "" };
  let future = "";

  const as = <T>(work: (tx: TransactionClient) => Promise<T>): Promise<T> => withTenant(clinic.tenantId, actorFor(clinic.userId), work);
  const call = async (who: keyof typeof tokens, method: string, path: string, body?: unknown) => {
    const response = await fetch(`${baseUrl}${path}`, { method, headers: { authorization: `Bearer ${tokens[who]}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: (await response.json().catch(() => null)) as Record<string, unknown> };
  };
  const items = async () => ((await call("admin", "GET", `/branches/${branchB}/exception-review`)).body["items"] as { id: string; decision: string | null; exception: { id: string } }[]);
  const reviewOf = async (exceptionId: string) => (await items()).find((item) => item.exception.id === exceptionId)!;
  async function member(role: MembershipRole): Promise<string> {
    const userId = await createTestUser();
    users.push(userId);
    const membershipId = randomUUID();
    await as((tx) => tx.membership.create({ data: injected({ id: membershipId, userId, role, status: "ACTIVE" }) }));
    return issueAccessToken({ sub: userId, membershipId, tenantId: clinic.tenantId, role });
  }
  const exception = (data: { doctorId: string | null; date: string; type: "BLOCKED" | "HOLIDAY"; branchId: string | null; scope: "ONE_BRANCH" | "EVERY_BRANCH" }) => {
    const id = randomUUID();
    return as((tx) => tx.scheduleException.create({ data: injected({ id, ...data, date: new Date(`${data.date}T00:00:00Z`),
      startTime: new Date("1970-01-01T10:00:00Z"), endTime: new Date("1970-01-01T12:00:00Z"), reason: "conference" }) })).then(() => id);
  };

  beforeAll(async () => {
    process.env["ATTACHMENTS_STORAGE_ROOT"] ??= process.cwd();
    clinic = await seedClinic();
    const { timezone } = await as((tx) => tx.tenant.findUniqueOrThrow({ where: { id: clinic.tenantId }, select: { timezone: true } }));
    const today = todayInClinic(timezone);
    const shift = (days: number) => new Date(Date.parse(`${today}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
    future = shift(7);
    ids.inA = await exception({ doctorId: clinic.doctorId, date: future, type: "BLOCKED", branchId: clinic.branchId, scope: "ONE_BRANCH" });
    ids.everyBranch = await exception({ doctorId: clinic.doctorId, date: shift(8), type: "BLOCKED", branchId: null, scope: "EVERY_BRANCH" });
    ids.clinicWide = await exception({ doctorId: null, date: shift(9), type: "HOLIDAY", branchId: null, scope: "EVERY_BRANCH" });
    ids.past = await exception({ doctorId: clinic.doctorId, date: shift(-1), type: "BLOCKED", branchId: clinic.branchId, scope: "ONE_BRANCH" });

    branchB = randomUUID();
    opened = await as(async (tx) => {
      await tx.branch.create({ data: injected({ id: branchB, name: "B", address: "Giza", phone: "+201000000001", receiptPrefix: "B", invoicePrefix: "B" }) });
      return openExceptionReview(tx, branchB, today);
    });
    tokens.admin = await member("ADMIN");
    tokens.reception = await member("RECEPTIONIST");
    app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: false });
    app.useGlobalPipes(refusingValidationPipe());
    await app.listen(0);
    baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await app?.close();
    await teardownClinic(clinic);
    for (const id of users) await deleteTestUser(id);
  });

  test("every future-dated exception is put to the clinic, one-branch ones too; a past one is not", async () => {
    expect(opened).toBe(3);
    expect((await items()).map((item) => item.exception.id).sort()).toEqual([ids.inA, ids.everyBranch, ids.clinicWide].sort());
    expect((await call("reception", "GET", `/branches/${branchB}/exception-review`)).status).toBe(403);
  });

  test("COPY_TO_NEW_BRANCH adds the same exception to the new branch, once; the decision is final", async () => {
    const review = await reviewOf(ids.inA);
    expect((await call("admin", "PUT", `/branches/${branchB}/exception-review/${review.id}`, { decision: "COPY_TO_NEW_BRANCH" })).body).toEqual({ decision: "COPY_TO_NEW_BRANCH" });
    const inB = await as((tx) => tx.scheduleException.findMany({ where: { branchId: branchB }, select: { doctorId: true, date: true, type: true, scope: true, reason: true, startTime: true } }));
    expect(inB).toEqual([{ doctorId: clinic.doctorId, date: new Date(`${future}T00:00:00Z`), type: "BLOCKED", scope: "ONE_BRANCH", reason: "conference", startTime: new Date("1970-01-01T10:00:00Z") }]);
    expect((await call("admin", "PUT", `/branches/${branchB}/exception-review/${review.id}`, { decision: "COPY_TO_NEW_BRANCH" })).body).toMatchObject({ code: "ALREADY_DECIDED" });
    expect(await as((tx) => tx.scheduleException.count({ where: { branchId: branchB } }))).toBe(1);
    expect((await reviewOf(ids.inA)).decision).toBe("COPY_TO_NEW_BRANCH");
  });

  test("an every-branch exception already covers the new branch: it can be kept, never copied", async () => {
    const review = await reviewOf(ids.everyBranch);
    expect((await call("admin", "PUT", `/branches/${branchB}/exception-review/${review.id}`, { decision: "COPY_TO_NEW_BRANCH" })).body).toMatchObject({ code: "INVALID_FIELD", params: { field: "decision" } });
    expect((await call("admin", "PUT", `/branches/${branchB}/exception-review/${review.id}`, { decision: "KEEP" })).body).toEqual({ decision: "KEEP" });
    expect(await as((tx) => tx.scheduleException.count({ where: { branchId: branchB } }))).toBe(1);
  });

  test("a review is reached only through its own branch", async () => {
    const review = await reviewOf(ids.clinicWide);
    expect((await call("admin", "PUT", `/branches/${clinic.branchId}/exception-review/${review.id}`, { decision: "KEEP" })).status).toBe(404);
  });
});
