import { createHmac, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { AppModule } from "../../src/app.module.ts";
import { refusingValidationPipe } from "../../src/common/validation-pipe.ts";
import type { MembershipRole } from "../../src/generated/prisma/enums.ts";
import { issueAccessToken } from "../../src/modules/auth/jwt.ts";
import { injected } from "../../src/prisma/injected.ts";
import { type TransactionClient, withTenant } from "../../src/prisma/with-tenant.ts";
import { actorFor, createTestUser, deleteTestUser, seedClinic, teardownClinic, type ClinicFixture } from "./fixtures.ts";

// A Wednesday (weekday 3, the day the doctor's template in branch B covers) inside the booking horizon.
const WEDNESDAY = ((): string => {
  const day = new Date(Date.now() + 3 * 86_400_000);
  while (day.getUTCDay() !== 3) day.setUTCDate(day.getUTCDate() + 1);
  return day.toISOString().slice(0, 10);
})();

describe("branch scope on the write paths (step 4a)", () => {
  let app: NestExpressApplication;
  let baseUrl = "";
  let clinic: ClinicFixture;
  let branchA = "";
  let branchB = "";
  let appointmentInB = "";
  const users: string[] = [];
  const tokens = { reception: "", scopedAdmin: "", admin: "" };

  const as = <T>(work: (tx: TransactionClient) => Promise<T>): Promise<T> =>
    withTenant(clinic.tenantId, actorFor(clinic.userId), work);

  const send = (who: keyof typeof tokens, method: string, path: string, body?: unknown): Promise<Response> =>
    fetch(`${baseUrl}${path}`, {
      method,
      headers: { authorization: `Bearer ${tokens[who]}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  async function member(role: MembershipRole, onlyBranch?: string): Promise<string> {
    const userId = await createTestUser();
    users.push(userId);
    const membershipId = randomUUID();
    await as(async (tx) => {
      await tx.membership.create({ data: injected({ id: membershipId, userId, role, status: "ACTIVE" }) });
      if (onlyBranch === undefined) return;
      await tx.membership.update({ where: { id: membershipId }, data: { branchScope: "SELECTED" } });
      await tx.membershipBranch.deleteMany({ where: { membershipId } });
      await tx.membershipBranch.create({ data: injected({ id: randomUUID(), membershipId, branchId: onlyBranch }) });
    });
    return issueAccessToken({ sub: userId, membershipId, tenantId: clinic.tenantId, role });
  }

  const legacyToken = (): string => {
    const start = Date.parse(`${WEDNESDAY}T08:00:00Z`);
    const body = [clinic.tenantId, clinic.doctorId, clinic.serviceId, start, start + 30 * 60_000, Date.now() + 60_000, "ab12"].join(".");
    const signature = createHmac("sha256", process.env["SLOT_TOKEN_SECRET"]!).update(body).digest("base64url");
    return `${Buffer.from(body).toString("base64url")}.${signature}`;
  };

  beforeAll(async () => {
    process.env["ATTACHMENTS_STORAGE_ROOT"] ??= process.cwd();
    clinic = await seedClinic();
    branchA = clinic.branchId;

    // Written in the default branch; both rows move to branch B below.
    const made = await as(async (tx) => {
      await tx.scheduleTemplate.create({
        data: injected({
          id: randomUUID(),
          branchId: clinic.branchId,
          doctorId: clinic.doctorId,
          weekday: 3,
          startTime: new Date("1970-01-01T07:00:00Z"),
          endTime: new Date("1970-01-01T10:00:00Z"),
          validFrom: new Date("2020-01-01"),
        }),
      });
      const id = randomUUID();
      const start = new Date(`${WEDNESDAY}T07:00:00Z`);
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
    });
    appointmentInB = made;
    branchB = randomUUID();
    await as(async (tx) => {
      await tx.branch.create({
        data: injected({ id: branchB, name: "Second", address: "Giza", phone: "+201000000001", receiptPrefix: "B", invoicePrefix: "B" }),
      });
      await tx.scheduleTemplate.updateMany({ data: { branchId: branchB } });
      await tx.appointment.update({ where: { id: appointmentInB }, data: { branchId: branchB } });
    });

    tokens.reception = await member("RECEPTIONIST");
    tokens.scopedAdmin = await member("ADMIN", branchA);
    tokens.admin = await member("ADMIN");

    app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: false });
    app.useGlobalPipes(refusingValidationPipe());
    await app.listen(0);
    baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await app?.close();
    await teardownClinic(clinic);
    for (const userId of users) await deleteTestUser(userId);
  });

  describe("booking", () => {
    let slotInB = "";

    test("each offered slot names the branch of the template it was cut from", async () => {
      // From an admin over every branch: since step 5b a receptionist scoped to A is not offered B's slots.
      const query = `doctorId=${clinic.doctorId}&serviceId=${clinic.serviceId}&date=${WEDNESDAY}`;
      const response = await send("admin", "GET", `/availability?${query}`);
      expect(response.status).toBe(200);
      const { slots } = (await response.json()) as { slots: { branchId: string; token: string }[] };
      expect(slots.length).toBeGreaterThan(0);
      expect(new Set(slots.map((s) => s.branchId))).toEqual(new Set([branchB]));
      slotInB = slots[0]!.token;
    });

    test("a receptionist scoped to branch A cannot book a slot in branch B: 404", async () => {
      const response = await send("reception", "POST", "/appointments", { slotToken: slotInB, patientId: clinic.patientId, source: "RECEPTION" });
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ code: "NOT_FOUND", params: { resource: "branch" } });
    });

    test("nor move branch B's appointment: 404, as if it were another clinic's", async () => {
      const response = await send("reception", "PATCH", `/appointments/${appointmentInB}/reschedule`, { slotToken: slotInB });
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ code: "NOT_FOUND", params: { resource: "appointment" } });
    });

    test("a token minted before branches is refused: its shape was retired in stage 5", async () => {
      const response = await send("admin", "POST", "/appointments", { slotToken: legacyToken(), patientId: clinic.patientId, source: "RECEPTION" });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: "INVALID_TOKEN" });
    });
  });

  describe("schedule exceptions", () => {
    const path = (): string => `/doctors/${clinic.doctorId}/schedule/exceptions`;
    const blocked = (branchId?: string) => ({ date: "2031-02-05", type: "BLOCKED", ...(branchId === undefined ? {} : { branchId }) });

    test("an admin scoped to branch A may block branch A", async () => {
      expect((await send("scopedAdmin", "POST", path(), blocked(branchA))).status).toBeLessThan(300);
    });

    test("but not branch B: 404", async () => {
      const response = await send("scopedAdmin", "POST", path(), blocked(branchB));
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ code: "NOT_FOUND", params: { resource: "branch" } });
    });

    test("and not every branch at once: SCOPE_TOO_NARROW", async () => {
      const response = await send("scopedAdmin", "POST", path(), blocked());
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ code: "SCOPE_TOO_NARROW" });
    });

    test("an admin over every branch may block them all", async () => {
      expect((await send("admin", "POST", path(), blocked())).status).toBeLessThan(300);
    });

    test("extra availability must say which branch the doctor will be in", async () => {
      const extra = { date: "2031-02-06", type: "EXTRA_AVAILABILITY", startTime: "18:00", endTime: "19:00" };
      const response = await send("admin", "POST", path(), extra);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: "BRANCH_REQUIRED" });
      expect((await send("admin", "POST", path(), { ...extra, branchId: branchB })).status).toBeLessThan(300);
    });

    const storedOn = (date: string) =>
      as((tx) => tx.scheduleException.findMany({ where: { date: new Date(date) }, select: { scope: true, branchId: true }, orderBy: { createdAt: "asc" } }));

    test("a doctor's absence with no branch is stored as every branch", async () => {
      expect((await send("admin", "POST", path(), { date: "2031-02-10", type: "BLOCKED" })).status).toBeLessThan(300);
      expect(await storedOn("2031-02-10")).toEqual([{ scope: "EVERY_BRANCH", branchId: null }]);
    });

    test("a clinic-wide closure with two branches must say where: BRANCH_REQUIRED, then each answer is stored", async () => {
      const closure = { doctorId: null, date: "2031-02-11", type: "HOLIDAY" };
      const refused = await send("admin", "POST", path(), closure);
      expect(refused.status).toBe(400);
      expect(await refused.json()).toMatchObject({ code: "BRANCH_REQUIRED" });
      expect((await send("admin", "POST", path(), { ...closure, scope: "EVERY_BRANCH" })).status).toBeLessThan(300);
      expect((await send("admin", "POST", path(), { ...closure, branchId: branchA })).status).toBeLessThan(300);
      expect(await storedOn("2031-02-11")).toEqual([
        { scope: "EVERY_BRANCH", branchId: null },
        { scope: "ONE_BRANCH", branchId: branchA },
      ]);
    });

    test("every branch and a named branch at once is refused: INVALID_FIELD", async () => {
      const response = await send("admin", "POST", path(), { date: "2031-02-12", type: "BLOCKED", branchId: branchA, scope: "EVERY_BRANCH" });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: "INVALID_FIELD" });
    });

    test("a scoped admin cannot delete an every-branch exception: SCOPE_TOO_NARROW", async () => {
      const everywhere = await as((tx) =>
        tx.scheduleException.create({ data: injected({ id: randomUUID(), doctorId: clinic.doctorId, date: new Date("2031-02-13"), type: "BLOCKED", branchId: null, scope: "EVERY_BRANCH" }) }),
      );
      const response = await send("scopedAdmin", "DELETE", `${path()}/${everywhere.id}`);
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ code: "SCOPE_TOO_NARROW" });
    });

    test("a scoped admin cannot delete branch B's exception: 404", async () => {
      const inB = await as((tx) =>
        tx.scheduleException.create({ data: injected({ id: randomUUID(), doctorId: clinic.doctorId, date: new Date("2031-02-07"), type: "BLOCKED", branchId: branchB, scope: "ONE_BRANCH" }) }),
      );
      const response = await send("scopedAdmin", "DELETE", `${path()}/${inB.id}`);
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ code: "NOT_FOUND", params: { resource: "exception" } });
    });
  });

  describe("write paths name their branch (step 4b stage 2)", () => {
    const THURSDAY = new Date(Date.parse(`${WEDNESDAY}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
    const templates = (weekday: number, startTime: string, endTime: string) => ({
      templates: [{ weekday, startTime, endTime, validFrom: "2020-01-01", breaks: [] }],
    });
    const templatesPath = (branchId?: string): string =>
      `/doctors/${clinic.doctorId}/schedule/templates${branchId === undefined ? "" : `?branchId=${branchId}`}`;
    const templateBranches = () =>
      as((tx) => tx.scheduleTemplate.findMany({ where: { doctorId: clinic.doctorId }, select: { branchId: true, weekday: true } }));
    let bookedInA = "";

    test("an admin scoped to branch A replaces branch A's templates, and branch B's are untouched", async () => {
      const response = await send("scopedAdmin", "PUT", templatesPath(branchA), templates(4, "07:00", "10:00"));
      expect(response.status).toBeLessThan(300);
      const rows = await templateBranches();
      expect(rows.filter((t) => t.branchId === branchB).map((t) => t.weekday)).toEqual([3]);
      expect(rows.filter((t) => t.branchId === branchA).map((t) => t.weekday)).toEqual([4]);
    });

    test("but not branch B's: 404", async () => {
      const response = await send("scopedAdmin", "PUT", templatesPath(branchB), templates(5, "07:00", "10:00"));
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ code: "NOT_FOUND", params: { resource: "branch" } });
    });

    test("with two branches, a replace must name its branch", async () => {
      const response = await send("admin", "PUT", templatesPath(), templates(5, "07:00", "10:00"));
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: "BRANCH_REQUIRED" });
    });

    test("a set overlapping the doctor's hours in another branch is refused, and nothing is replaced", async () => {
      const response = await send("admin", "PUT", templatesPath(branchA), templates(3, "08:00", "09:00"));
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: "OVERLAPPING_TEMPLATE" });
      expect((await templateBranches()).filter((t) => t.branchId === branchA).map((t) => t.weekday)).toEqual([4]);
    });

    test("a receptionist books in branch A, and the appointment records branch A", async () => {
      const query = `doctorId=${clinic.doctorId}&serviceId=${clinic.serviceId}&date=${THURSDAY}`;
      const { slots } = (await (await send("reception", "GET", `/availability?${query}`)).json()) as { slots: { branchId: string; token: string }[] };
      expect(new Set(slots.map((s) => s.branchId))).toEqual(new Set([branchA]));
      const response = await send("reception", "POST", "/appointments", { slotToken: slots[0]!.token, patientId: clinic.patientId, source: "RECEPTION" });
      expect(response.status).toBeLessThan(300);
      bookedInA = ((await response.json()) as { appointmentId: string }).appointmentId;
      const row = await as((tx) => tx.appointment.findUniqueOrThrow({ where: { id: bookedInA }, select: { branchId: true } }));
      expect(row.branchId).toBe(branchA);
    });

    test("and takes a payment for it, numbered in branch A", async () => {
      const response = await send("reception", "POST", "/payments", { patientId: clinic.patientId, appointmentId: bookedInA, amountMinor: 100, method: "CASH" });
      expect(response.status).toBeLessThan(300);
      const receipt = await as((tx) => tx.payment.findFirstOrThrow({ where: { appointmentId: bookedInA }, select: { branchId: true } }));
      expect(receipt.branchId).toBe(branchA);
    });

    test("but cannot take one for branch B's appointment: 404", async () => {
      const response = await send("reception", "POST", "/payments", { patientId: clinic.patientId, appointmentId: appointmentInB, amountMinor: 100, method: "CASH" });
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ code: "NOT_FOUND", params: { resource: "appointment" } });
    });

    test("nor against branch B's charge: 404", async () => {
      const chargeId = await as(async (tx) => {
        const visitId = randomUUID();
        await tx.visit.create({
          data: injected({ id: visitId, patientId: clinic.patientId, doctorId: clinic.doctorId, appointmentId: appointmentInB, status: "DRAFT", createdBy: clinic.userId }),
        });
        return (await tx.visitCharge.create({ data: injected({ id: randomUUID(), visitId, patientId: clinic.patientId }) })).id;
      });
      const response = await send("reception", "POST", "/payments", { patientId: clinic.patientId, chargeId, amountMinor: 100, method: "CASH" });
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ code: "NOT_FOUND", params: { resource: "visit" } });
    });
  });
});
