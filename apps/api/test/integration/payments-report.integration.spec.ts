import { ThrottlingModule } from "../../src/common/throttling.module.ts";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Module, ValidationPipe } from "@nestjs/common";
import { APP_INTERCEPTOR, NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { ActorContextInterceptor } from "../../src/common/actor-context.interceptor.ts";
import { issueAccessToken } from "../../src/modules/auth/jwt.ts";
import { BillingActionsController } from "../../src/modules/billing/billing-actions.controller.ts";
import { prisma } from "../../src/prisma/client.ts";
import { injected } from "../../src/prisma/injected.ts";
import { withTenant } from "../../src/prisma/with-tenant.ts";
import { actorFor, createTestUser, seedClinic, teardownClinic, type ClinicFixture } from "./fixtures.ts";

/**
 * «تقارير المدفوعات» — Phase 5 PR 14.
 *
 * **The guard the capability registry asked for in as many words** when `reports.financial` had no
 * consumer: *"scope a DOCTOR's report to their own data explicitly rather than relying on a WHERE
 * clause that happens to be right, and test the refusal."* So the file below proves two things — a
 * doctor's report contains their own figures and none of a colleague's, in every section **and in
 * the totals**, and reception cannot reach the route at all.
 *
 * Scoping the rows and not the totals is the specific failure worth naming: it hands a doctor the
 * clinic's takings as a subtraction, which is a leak that looks like a rounding question.
 */

@Module({
  // A rate-limited route lives here (4b), so its guard needs the throttler options in scope.
  imports: [ThrottlingModule],
  controllers: [BillingActionsController],
  providers: [{ provide: APP_INTERCEPTOR, useClass: ActorContextInterceptor }],
})
class ReportTestModule {}

interface Report {
  period: string;
  on: string;
  from: string;
  to: string;
  collectedMinor: number;
  byMethod: { method: string; totalMinor: number }[];
  byDoctor: { doctorId: string; collectedMinor: number; chargedMinor: number; outstandingMinor: number }[];
  outstandingMinor: number;
  outstanding: { chargeId: string }[];
  scope: "CLINIC" | "OWN";
}

describe("the payments report", () => {
  let app: NestExpressApplication;
  let baseUrl: string;
  let clinic: ClinicFixture;
  let adminToken = "";
  let doctorToken = "";
  let receptionToken = "";
  let colleagueDoctorId = "";
  let today = "";

  let slot = 0;
  const nextStart = (): Date => {
    slot += 1;
    // Today, walking backwards through the working day, so every charge lands in today's period.
    return new Date(Date.now() - slot * 7 * 60_000);
  };

  const get = async (path: string, token: string): Promise<{ status: number; text: string }> => {
    const response = await fetch(`${baseUrl}${path}`, { headers: { authorization: `Bearer ${token}` } });
    return { status: response.status, text: await response.text() };
  };

  /** A completed visit with a charge, and optionally a receipt against it. */
  const billed = async (
    doctorId: string,
    subtotalMinor: number,
    paidMinor: number,
  ): Promise<string> =>
    withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) => {
      const start = nextStart();
      const appointmentId = randomUUID();
      await tx.appointment.create({
        data: injected({
          id: appointmentId,
          patientId: clinic.patientId,
          doctorId,
          serviceId: clinic.serviceId,
          scheduledStart: start,
          scheduledEnd: new Date(start.getTime() + 5 * 60_000),
          status: "COMPLETED",
          source: "RECEPTION",
          createdBy: clinic.userId,
          updatedBy: clinic.userId,
          allowOverlap: true,
        }),
      });
      const visitId = randomUUID();
      await tx.visit.create({
        data: injected({
          id: visitId,
          patientId: clinic.patientId,
          doctorId,
          appointmentId,
          status: "COMPLETED",
          createdBy: clinic.userId,
        }),
      });
      const chargeId = randomUUID();
      await tx.visitCharge.create({
        data: injected({ id: chargeId, visitId, patientId: clinic.patientId, subtotalMinor }),
      });
      if (paidMinor > 0) {
        await tx.payment.create({
          data: injected({
            id: randomUUID(),
            patientId: clinic.patientId,
            appointmentId,
            visitId,
            chargeId,
            amountMinor: paidMinor,
            method: "CASH",
            status: "PAID",
            collectedByUserId: clinic.userId,
            paidAt: new Date(),
          }),
        });
      }
      return chargeId;
    });

  beforeAll(async () => {
    clinic = await seedClinic();

    const colleagueUserId = await createTestUser();
    await withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) => {
      const membershipId = randomUUID();
      await tx.membership.create({
        data: injected({ id: membershipId, userId: colleagueUserId, role: "DOCTOR", status: "ACTIVE" }),
      });
      colleagueDoctorId = randomUUID();
      await tx.doctor.create({
        data: injected({
          id: colleagueDoctorId,
          membershipId,
          specialty: "General",
          licenseNumber: `LIC-${colleagueDoctorId.replace(/-/g, "").slice(0, 8)}`,
          title: "Dr.",
        }),
      });
    });

    // 100,000 billed and 40,000 taken for the fixture doctor; 50,000 billed and all of it taken
    // for the colleague. Different figures on purpose: a scoping bug shows up as the wrong total.
    await billed(clinic.doctorId, 100_000, 40_000);
    await billed(colleagueDoctorId, 50_000, 50_000);

    const claims = { sub: clinic.userId, tenantId: clinic.tenantId } as const;
    doctorToken = await issueAccessToken({ ...claims, membershipId: clinic.membershipId, role: "DOCTOR" });

    const [adminMembership, receptionMembership] = await withTenant(
      clinic.tenantId,
      actorFor(clinic.userId),
      async (tx) => {
        const ids = [randomUUID(), randomUUID()] as const;
        await tx.membership.create({
          data: injected({ id: ids[0], userId: clinic.userId, role: "ADMIN", status: "ACTIVE" }),
        });
        await tx.membership.create({
          data: injected({ id: ids[1], userId: clinic.userId, role: "RECEPTIONIST", status: "ACTIVE" }),
        });
        return ids;
      },
    );
    adminToken = await issueAccessToken({ ...claims, membershipId: adminMembership, role: "ADMIN" });
    receptionToken = await issueAccessToken({ ...claims, membershipId: receptionMembership, role: "RECEPTIONIST" });

    const tenant = await withTenant(clinic.tenantId, actorFor(clinic.userId), (tx) =>
      tx.tenant.findFirstOrThrow({ select: { timezone: true } }),
    );
    today = new Intl.DateTimeFormat("en-CA", { timeZone: tenant.timezone }).format(new Date());

    app = await NestFactory.create<NestExpressApplication>(ReportTestModule, { logger: false });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.listen(0, "127.0.0.1");
    baseUrl = `http://127.0.0.1:${((app.getHttpServer() as Server).address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await app?.close();
    await teardownClinic(clinic);
    await prisma.$disconnect();
  });

  test("an admin sees the clinic's day: what came in, what is owed, and per doctor", async () => {
    const { status, text } = await get(`/reports/payments?period=DAY&on=${today}`, adminToken);
    expect(status).toBe(200);
    const report = JSON.parse(text) as Report;

    expect(report.scope).toBe("CLINIC");
    expect(report.collectedMinor).toBe(90_000);
    expect(report.byMethod).toEqual([{ method: "CASH", totalMinor: 90_000 }]);
    // 60,000 still owed on the first charge; the colleague's is settled.
    expect(report.outstandingMinor).toBe(60_000);

    const bothDoctors = report.byDoctor.map((row) => row.doctorId).sort();
    expect(bothDoctors).toEqual([clinic.doctorId, colleagueDoctorId].sort());
  });

  /**
   * **The registry's guard: a doctor's report is their own, totals included.**
   *
   * Scoping the rows and leaving the totals clinic-wide is the failure that matters — it hands a
   * doctor the clinic's takings as a subtraction, which looks like an arithmetic question rather
   * than a leak.
   */
  test("a doctor sees only their own figures, in the rows and in the totals", async () => {
    const report = JSON.parse(
      (await get(`/reports/payments?period=DAY&on=${today}`, doctorToken)).text,
    ) as Report;

    expect(report.scope).toBe("OWN");
    // Their own 40,000, and not the clinic's 90,000.
    expect(report.collectedMinor).toBe(40_000);
    expect(report.outstandingMinor).toBe(60_000);
    expect(report.byMethod).toEqual([{ method: "CASH", totalMinor: 40_000 }]);
    expect(report.byDoctor.map((row) => row.doctorId)).toEqual([clinic.doctorId]);
    // The colleague appears nowhere in the payload at all, not even as an id.
    expect(JSON.stringify(report)).not.toContain(colleagueDoctorId);
  });

  /** **Omitting the period gives the month — ruled 2026-09-14.** The screen's default and the
   *  route's default are the same one, so a caller that omits it is not handed the empty period. */
  test("with no period at all, the answer is this month", async () => {
    const report = JSON.parse((await get("/reports/payments", adminToken)).text) as Report;
    expect(report.period).toBe("MONTH");
    expect(report.on).toBe(today.slice(0, 7));
    expect(report.from).toBe(`${today.slice(0, 7)}-01`);
  });

  test("a month is a month, and its bounds are the calendar's", async () => {
    const month = today.slice(0, 7);
    const report = JSON.parse(
      (await get(`/reports/payments?period=MONTH&on=${month}`, adminToken)).text,
    ) as Report;

    expect(report.from).toBe(`${month}-01`);
    // February is got right without a table of month lengths: day zero of the next month.
    expect(report.to.startsWith(month)).toBe(true);
    expect(Number(report.to.slice(-2))).toBeGreaterThanOrEqual(28);
    expect(report.collectedMinor).toBe(90_000);
  });

  test("a period that is neither a day nor a month is refused with 422", async () => {
    const refused = await get("/reports/payments?period=MONTH&on=2026-09-09", adminToken);
    expect(refused.status).toBe(422);
    expect(JSON.parse(refused.text)).toMatchObject({ code: "INVALID_PERIOD" });

    // A shape the server never offered is 400, which is a different answer on purpose.
    expect((await get("/reports/payments?period=WEEK", adminToken)).status).toBe(400);
  });

  test("reception cannot reach the report at all", async () => {
    // `reports.financial` is NONE for RECEPTIONIST: refused at the guard, before any handler runs.
    expect((await get(`/reports/payments?period=DAY&on=${today}`, receptionToken)).status).toBe(403);
  });

  test("a day with nothing in it reports zero rather than failing", async () => {
    const quiet = JSON.parse(
      (await get("/reports/payments?period=DAY&on=2020-01-01", adminToken)).text,
    ) as Report;
    expect(quiet.collectedMinor).toBe(0);
    expect(quiet.byMethod).toEqual([]);
    // The outstanding balance is deliberately not period-bounded: a debt does not expire because
    // somebody selected a quiet day in 2020.
    expect(quiet.outstandingMinor).toBe(60_000);
  });
});
