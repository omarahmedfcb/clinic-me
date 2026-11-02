import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { AppModule } from "../../src/app.module.ts";
import { todayInClinic } from "../../src/common/clinic-time.ts";
import { refusingValidationPipe } from "../../src/common/validation-pipe.ts";
import { addDays } from "../../src/modules/appointments/domain/zoned-time.ts";
import { issueAccessToken } from "../../src/modules/auth/jwt.ts";
import { injected } from "../../src/prisma/injected.ts";
import { type TransactionClient, withTenant } from "../../src/prisma/with-tenant.ts";
import { actorFor, seedClinic, teardownClinic, type ClinicFixture } from "./fixtures.ts";

// The doctor works in A on the requested day and in B two days later; in C never. A follow-up books
// into the visit's own branch, or one the caller names, and never anywhere else (ruled 2026-10-29).
describe("a follow-up books into the visit's branch, or one the caller names", () => {
  let app: NestExpressApplication;
  let baseUrl = "";
  let clinic: ClinicFixture;
  let other: ClinicFixture;
  let token = "";
  const branch = { a: "", b: "", c: "" };
  let requested = "";
  let daysBack = 0;

  const as = <T>(work: (tx: TransactionClient) => Promise<T>): Promise<T> =>
    withTenant(clinic.tenantId, actorFor(clinic.userId), work);
  const call = (path: string, body?: unknown): Promise<Response> =>
    fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  /** A visit in consultation in `branchId`, on a past day so no two of them overlap. */
  async function visitIn(branchId: string): Promise<{ appointmentId: string; visitId: string; revision: number }> {
    const appointmentId = randomUUID();
    daysBack += 1;
    const start = new Date(Date.now() - daysBack * 86_400_000);
    await as((tx) =>
      tx.appointment.create({
        data: injected({
          id: appointmentId,
          branchId,
          patientId: clinic.patientId,
          doctorId: clinic.doctorId,
          serviceId: clinic.serviceId,
          scheduledStart: start,
          scheduledEnd: new Date(start.getTime() + 20 * 60_000),
          status: "IN_CONSULTATION",
          source: "RECEPTION",
          createdBy: clinic.userId,
          updatedBy: clinic.userId,
        }),
      }),
    );
    const draft = await call(`/appointments/${appointmentId}/visit/draft`);
    expect(draft.status).toBe(201);
    const { id, revision } = (await draft.json()) as { id: string; revision: number };
    return { appointmentId, visitId: id, revision };
  }

  const complete = (v: { appointmentId: string; visitId: string; revision: number }, extra: object = {}) =>
    call(`/appointments/${v.appointmentId}/visit/${v.visitId}/complete`, { expectedRevision: v.revision, followUpDate: requested, ...extra });

  const followUpsBooked = () => as((tx) => tx.appointment.findMany({ where: { source: "DOCTOR" }, select: { branchId: true } }));

  beforeAll(async () => {
    process.env["ATTACHMENTS_STORAGE_ROOT"] ??= process.cwd();
    clinic = await seedClinic();
    other = await seedClinic();
    branch.a = clinic.branchId;
    branch.b = randomUUID();
    branch.c = randomUUID();
    const tenant = await as((tx) => tx.tenant.findUniqueOrThrow({ where: { id: clinic.tenantId }, select: { timezone: true } }));
    requested = addDays(todayInClinic(tenant.timezone), 3);
    const weekday = (day: string): number => new Date(`${day}T00:00:00Z`).getUTCDay();
    await as(async (tx) => {
      for (const [id, prefix] of [[branch.b, "B"], [branch.c, "C"]] as const) {
        await tx.branch.create({ data: injected({ id, name: prefix, address: "Giza", phone: "+201000000001", receiptPrefix: prefix, invoicePrefix: prefix }) });
      }
      for (const [branchId, day] of [[branch.a, requested], [branch.b, addDays(requested, 2)]] as const) {
        await tx.scheduleTemplate.create({
          data: injected({
            id: randomUUID(),
            branchId,
            doctorId: clinic.doctorId,
            weekday: weekday(day),
            startTime: new Date("1970-01-01T09:00:00Z"),
            endTime: new Date("1970-01-01T12:00:00Z"),
            validFrom: new Date("2020-01-01"),
          }),
        });
      }
    });
    token = await issueAccessToken({ sub: clinic.userId, membershipId: clinic.membershipId, tenantId: clinic.tenantId, role: "DOCTOR" });

    app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: false });
    app.useGlobalPipes(refusingValidationPipe());
    await app.listen(0);
    baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await app?.close();
    await teardownClinic(clinic);
    await teardownClinic(other);
  });

  test("a visit in branch B books its follow-up in B, on the next day the doctor works there", async () => {
    const response = await complete(await visitIn(branch.b));
    expect(response.status).toBe(201);
    const { followUpAppointmentId, followUpBooking } = (await response.json()) as {
      followUpAppointmentId: string;
      followUpBooking: { booked: boolean; branchId: string; date: string };
    };
    expect(followUpBooking).toEqual({ booked: true, appointmentId: followUpAppointmentId, branchId: branch.b, date: addDays(requested, 2) });
    const row = await as((tx) => tx.appointment.findUniqueOrThrow({ where: { id: followUpAppointmentId }, select: { branchId: true } }));
    expect(row.branchId).toBe(branch.b);
  });

  test("a branch with no slot in the horizon says so and names itself; nothing lands elsewhere", async () => {
    const before = (await followUpsBooked()).length;
    const response = await complete(await visitIn(branch.c));
    expect(response.status).toBe(201);
    const body = (await response.json()) as { followUpAppointmentId: null; followUpBooking: { booked: boolean; branchId: string; searchedUntil: string } };
    expect(body.followUpAppointmentId).toBeNull();
    expect(body.followUpBooking).toMatchObject({ booked: false, branchId: branch.c });
    expect(body.followUpBooking.searchedUntil).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect((await followUpsBooked()).length).toBe(before);
  });

  test("another branch is used only when the caller names it", async () => {
    const response = await complete(await visitIn(branch.b), { followUpBranchId: branch.a });
    expect(response.status).toBe(201);
    const { followUpBooking } = (await response.json()) as { followUpBooking: { booked: boolean; branchId: string; date: string } };
    expect(followUpBooking).toMatchObject({ booked: true, branchId: branch.a, date: requested });
  });

  test("naming another clinic's branch is refused, and the visit is not completed", async () => {
    const visit = await visitIn(branch.b);
    const response = await complete(visit, { followUpBranchId: other.branchId });
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: "NOT_FOUND", params: { resource: "branch" } });
    const stored = await as((tx) => tx.visit.findUniqueOrThrow({ where: { id: visit.visitId }, select: { status: true } }));
    expect(stored.status).toBe("DRAFT");
  });

  test("naming a branch outside the doctor's own scope is refused", async () => {
    const response = await complete(await visitIn(branch.b), { followUpBranchId: branch.c });
    expect(response.status).toBe(404);
  });
});
