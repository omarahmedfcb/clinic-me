import { createHmac, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { AppModule } from "../../src/app.module.ts";
import { branchContext } from "../../src/common/branch-context.ts";
import { awaitingWritePath, BRANCH_ENFORCEMENT } from "../../src/common/branch-enforcement.ts";
import { refusingValidationPipe } from "../../src/common/validation-pipe.ts";
import type { MembershipRole } from "../../src/generated/prisma/enums.ts";
import { issueAccessToken } from "../../src/modules/auth/jwt.ts";
import { verifySlotToken } from "../../src/modules/appointments/slot-token.ts";
import { prisma } from "../../src/prisma/client.ts";
import { injected } from "../../src/prisma/injected.ts";
import { type TransactionClient, withTenant } from "../../src/prisma/with-tenant.ts";
import { actorFor, createTestUser, deleteTestUser, seedClinic, teardownClinic, type ClinicFixture } from "./fixtures.ts";

const as = <T>(clinic: ClinicFixture, work: (tx: TransactionClient) => Promise<T>): Promise<T> =>
  withTenant(clinic.tenantId, actorFor(clinic.userId), work);

async function appointment(tx: TransactionClient, clinic: ClinicFixture, hour: number): Promise<string> {
  const id = randomUUID();
  const start = new Date(Date.UTC(2031, 0, 1, hour, 0));
  await tx.appointment.create({
    data: injected({
      id,
      branchId: clinic.branchId,
      patientId: clinic.patientId,
      doctorId: clinic.doctorId,
      serviceId: clinic.serviceId,
      scheduledStart: start,
      scheduledEnd: new Date(start.getTime() + 30 * 60_000),
      status: "BOOKED",
      source: "RECEPTION",
      createdBy: clinic.userId,
      updatedBy: clinic.userId,
    }),
  });
  return id;
}

describe("the interim fill is gone, and nothing it excused survives it (branches stage 5)", () => {
  test("neither interim function is installed", async () => {
    const [row] = await prisma.$queryRaw<{ installed: number }[]>`
      SELECT count(*)::int AS installed FROM pg_proc WHERE proname IN ('interim_sole_branch', 'interim_fill_sole_branch')
    `;
    expect(row!.installed).toBe(0);
  });

  test("no route is awaiting its write path", () => {
    expect(awaitingWritePath(BRANCH_ENFORCEMENT)).toEqual([]);
  });

  test("the seven-field slot token shape, correctly signed and unexpired, is refused as malformed", () => {
    const tenantId = randomUUID();
    const body = [tenantId, randomUUID(), randomUUID(), 1, 2, Date.now() + 60_000, "ab12"].join(".");
    const signature = createHmac("sha256", process.env["SLOT_TOKEN_SECRET"]!).update(body).digest("base64url");
    const legacy = verifySlotToken(`${Buffer.from(body).toString("base64url")}.${signature}`, tenantId, new Date());
    expect(legacy).toMatchObject({ ok: false, failure: "MALFORMED" });
  });
});

describe("branch scope is enforced by the API", () => {
  let app: NestExpressApplication;
  let baseUrl = "";
  let clinic: ClinicFixture;
  let other: ClinicFixture;
  let branchA = "";
  let branchB = "";
  let otherClinicBranch = "";
  let appointmentA = "";
  let visitB = "";
  const users: string[] = [];
  const tokens: Record<"reception" | "doctor", string> = { reception: "", doctor: "" };

  const call = (who: keyof typeof tokens, path: string, branch?: string): Promise<Response> =>
    fetch(`${baseUrl}${path}`, {
      headers: { authorization: `Bearer ${tokens[who]}`, ...(branch === undefined ? {} : { "x-branch-id": branch }) },
    });
  const queuePath = "/queue/today?date=2031-01-01";

  async function member(role: MembershipRole): Promise<string> {
    const userId = await createTestUser();
    users.push(userId);
    const membershipId = randomUUID();
    await as(clinic, (tx) => tx.membership.create({ data: injected({ id: membershipId, userId, role, status: "ACTIVE" }) }));
    return issueAccessToken({ sub: userId, membershipId, tenantId: clinic.tenantId, role });
  }

  beforeAll(async () => {
    process.env["ATTACHMENTS_STORAGE_ROOT"] ??= process.cwd();
    clinic = await seedClinic();
    other = await seedClinic();
    otherClinicBranch = (await as(other, (tx) => tx.branch.findFirstOrThrow({ where: { isDefault: true } }))).id;
    tokens.reception = await member("RECEPTIONIST");
    tokens.doctor = await issueAccessToken({
      sub: clinic.userId,
      membershipId: clinic.membershipId,
      tenantId: clinic.tenantId,
      role: "DOCTOR",
    });

    // Written in the default branch; the second appointment and the template move to branch B below.
    const made = await as(clinic, async (tx) => {
      const a = await appointment(tx, clinic, 6);
      const b = await appointment(tx, clinic, 7);
      await tx.scheduleTemplate.create({
        data: injected({
          id: randomUUID(),
          branchId: clinic.branchId,
          doctorId: clinic.doctorId,
          weekday: 3,
          startTime: new Date("1970-01-01T09:00:00Z"),
          endTime: new Date("1970-01-01T13:00:00Z"),
          validFrom: new Date("2020-01-01"),
        }),
      });
      return { a, b, branch: (await tx.branch.findFirstOrThrow({ where: { isDefault: true } })).id };
    });
    branchA = made.branch;
    appointmentA = made.a;
    branchB = randomUUID();
    visitB = randomUUID();
    await as(clinic, async (tx) => {
      await tx.branch.create({
        data: injected({ id: branchB, name: "Second", address: "Giza", phone: "+201000000001", receiptPrefix: "B", invoicePrefix: "B" }),
      });
      await tx.appointment.update({ where: { id: made.b }, data: { branchId: branchB } });
      await tx.scheduleTemplate.updateMany({ data: { branchId: branchB } });
      await tx.visit.create({
        data: injected({ id: visitB, patientId: clinic.patientId, doctorId: clinic.doctorId, appointmentId: made.b, status: "DRAFT", createdBy: clinic.userId }),
      });
    });

    app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: false });
    app.useGlobalPipes(refusingValidationPipe());
    await app.listen(0);
    baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await app?.close();
    await teardownClinic(clinic);
    await teardownClinic(other);
    for (const userId of users) await deleteTestUser(userId);
  });

  test("/auth/me lists the branches each membership may select", async () => {
    const reception = (await (await call("reception", "/auth/me")).json()) as { branches: { id: string }[]; isMultiBranch: boolean };
    expect(reception.isMultiBranch).toBe(true);
    expect(reception.branches.map((b) => b.id)).toEqual([branchA]);

    const doctor = (await (await call("doctor", "/auth/me")).json()) as { branches: { id: string }[] };
    expect(doctor.branches.map((b) => b.id)).toEqual([branchB]);
  });

  test("a receptionist scoped to one branch reads it, with or without the header", async () => {
    expect((await call("reception", queuePath, branchA)).status).toBe(200);
    expect((await call("reception", queuePath)).status).toBe(200);
  });

  test("the same receptionist naming the other branch is refused by the API with 404", async () => {
    const response = await call("reception", queuePath, branchB);
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: "NOT_FOUND", params: { resource: "branch" } });
  });

  test("another clinic's branch is 404, the same as a branch that does not exist", async () => {
    expect((await call("reception", queuePath, otherClinicBranch)).status).toBe(404);
    expect((await call("reception", queuePath, randomUUID())).status).toBe(404);
  });

  test("the clinical file is readable from any branch", async () => {
    const history = await call("reception", `/patients/${clinic.patientId}/visits`, branchA);
    expect(history.status).toBe(200);
    expect(JSON.stringify(await history.json())).toContain(visitB);

    // The doctor may act only in branch B; the appointment is in branch A.
    const summary = await call("doctor", `/appointments/${appointmentA}/clinical-summary`, branchB);
    expect(summary.status).toBe(200);
  });

  test("withTenant binds the selected branch for the audit trigger, and no branch for all", async () => {
    const lastAuditBranch = async (selected: string): Promise<string | null> => {
      const context = { allowed: [branchA, branchB], selected, isMultiBranch: true, branches: [] };
      await branchContext.run(context, () =>
        as(clinic, (tx) => tx.patient.update({ where: { id: clinic.patientId }, data: { notes: selected } })),
      );
      const row = await as(clinic, (tx) =>
        tx.auditLog.findFirstOrThrow({ where: { entityId: clinic.patientId }, orderBy: { createdAt: "desc" } }),
      );
      return row.branchId;
    };
    expect(await lastAuditBranch(branchB)).toBe(branchB);
    expect(await lastAuditBranch("all")).toBeNull();
  });
});
