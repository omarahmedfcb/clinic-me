import { randomUUID } from "node:crypto";
import { Module, ValidationPipe } from "@nestjs/common";
import { APP_INTERCEPTOR, NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import type { AddressInfo } from "node:net";
import { ActorContextInterceptor } from "../../src/common/actor-context.interceptor.ts";
import { issueAccessToken } from "../../src/modules/auth/jwt.ts";
import { QueueController } from "../../src/modules/queue/queue.controller.ts";
import { calendarDayIn } from "../../src/modules/appointments/domain/zoned-time.ts";
import { prisma } from "../../src/prisma/client.ts";
import { injected } from "../../src/prisma/injected.ts";
import { withTenant } from "../../src/prisma/with-tenant.ts";
import {
  actorFor,
  createTestUser,
  seedClinic,
  teardownClinic,
  type ClinicFixture,
} from "./fixtures.ts";

/**
 * Reception sees that a visit is in progress, and nothing else — `PHASE-4.md` Q14, plan PR 5.
 *
 * The assertion that carries this file is the second one: **another doctor's draft on the same
 * appointment is not reported.** Q15 lets several drafts exist; Q14 grants reception the status of
 * the visit belonging to the appointment's own doctor. A test that only checked "a draft shows up"
 * would pass against a query that reported anybody's.
 */

@Module({
  controllers: [QueueController],
  providers: [{ provide: APP_INTERCEPTOR, useClass: ActorContextInterceptor }],
})
class QueueVisitStatusTestModule {}

interface Row {
  appointmentId: string;
  visitStatus: "DRAFT" | "COMPLETED" | null;
}

describe("the queue's visit status", () => {
  let app: NestExpressApplication;
  let baseUrl: string;
  let clinic: ClinicFixture;
  let receptionToken = "";
  let today = "";
  let secondDoctorId = "";
  let secondDoctorUserId = "";

  const queue = async (): Promise<Row[]> => {
    const response = await fetch(`${baseUrl}/queue/today?date=${today}`, {
      headers: { authorization: `Bearer ${receptionToken}` },
    });
    expect(response.status).toBe(200);
    return ((await response.json()) as { entries: Row[] }).entries;
  };

  /** An appointment on the clinic's own day, in consultation, so it is on the board. */
  const appointmentNow = async (): Promise<string> => {
    const id = randomUUID();
    await withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) => {
      const start = new Date();
      await tx.appointment.create({
        data: injected({
          id,
          patientId: clinic.patientId,
          doctorId: clinic.doctorId,
          serviceId: clinic.serviceId,
          scheduledStart: start,
          scheduledEnd: new Date(start.getTime() + 30 * 60_000),
          status: "IN_CONSULTATION",
          source: "RECEPTION",
          // Several of these sit at the same instant for one doctor, which `no_double_booking`
          // refuses — correctly. `allow_overlap` is the flag the constraint itself exempts, and it
          // keeps every fixture safely inside today, where the queue can see it.
          allowOverlap: true,
          arrivedAt: start,
          waitingStartedAt: start,
          consultationStartedAt: start,
          createdBy: clinic.userId,
          updatedBy: clinic.userId,
        }),
      });
    });
    return id;
  };

  beforeAll(async () => {
    clinic = await seedClinic();

    const tenant = await prisma.tenant.findUniqueOrThrow({
      where: { id: clinic.tenantId },
      select: { timezone: true },
    });
    today = calendarDayIn(new Date(), tenant.timezone);

    // A second doctor, for the draft that must not be reported.
    secondDoctorUserId = await createTestUser();
    await withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) => {
      const membershipId = randomUUID();
      await tx.membership.create({
        data: injected({ id: membershipId, userId: secondDoctorUserId, role: "DOCTOR", status: "ACTIVE" }),
      });
      secondDoctorId = randomUUID();
      await tx.doctor.create({
        data: injected({
          id: secondDoctorId,
          membershipId,
          specialty: "General",
          licenseNumber: `LIC-${secondDoctorId.slice(0, 8)}`,
          title: "Dr.",
        }),
      });
    });

    const receptionUserId = await createTestUser();
    let receptionMembershipId = "";
    await withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) => {
      receptionMembershipId = randomUUID();
      await tx.membership.create({
        data: injected({
          id: receptionMembershipId,
          userId: receptionUserId,
          role: "RECEPTIONIST",
          status: "ACTIVE",
        }),
      });
    });
    receptionToken = await issueAccessToken({
      sub: receptionUserId,
      membershipId: receptionMembershipId,
      tenantId: clinic.tenantId,
      role: "RECEPTIONIST",
    });

    app = await NestFactory.create<NestExpressApplication>(QueueVisitStatusTestModule, { logger: false });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.listen(0);
    baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await app?.close();
    await teardownClinic(clinic);
    await prisma.$disconnect();
  });

  test("no visit yet reads as null, not as an absent field", async () => {
    const appointmentId = await appointmentNow();
    const row = (await queue()).find((entry) => entry.appointmentId === appointmentId);
    // Present and null. An absent key would make a client's `?? "none"` and its `in` check disagree.
    expect(row).toBeDefined();
    expect(Object.keys(row ?? {})).toContain("visitStatus");
    expect(row?.visitStatus).toBeNull();
  });

  test("a draft by the appointment's own doctor reads as DRAFT", async () => {
    const appointmentId = await appointmentNow();
    await withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) => {
      await tx.visit.create({
        data: injected({
          patientId: clinic.patientId,
          doctorId: clinic.doctorId,
          appointmentId,
          status: "DRAFT",
          createdBy: clinic.userId,
        }),
      });
    });

    const row = (await queue()).find((entry) => entry.appointmentId === appointmentId);
    expect(row?.visitStatus).toBe("DRAFT");
  });

  test("another doctor's draft on the same appointment is not reception's business (Q15)", async () => {
    const appointmentId = await appointmentNow();
    await withTenant(clinic.tenantId, actorFor(secondDoctorUserId), async (tx) => {
      await tx.visit.create({
        data: injected({
          patientId: clinic.patientId,
          doctorId: secondDoctorId,
          appointmentId,
          status: "DRAFT",
          createdBy: secondDoctorUserId,
        }),
      });
    });

    const row = (await queue()).find((entry) => entry.appointmentId === appointmentId);
    // The appointment's own doctor has written nothing, so there is nothing to report.
    expect(row?.visitStatus).toBeNull();
  });

  test("a finished visit is never reported as still in progress", async () => {
    const appointmentId = await appointmentNow();
    await withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) => {
      await tx.visit.create({
        data: injected({
          patientId: clinic.patientId,
          doctorId: clinic.doctorId,
          appointmentId,
          status: "DRAFT",
          createdBy: clinic.userId,
        }),
      });
      await tx.visit.create({
        data: injected({
          patientId: clinic.patientId,
          doctorId: clinic.doctorId,
          appointmentId,
          status: "COMPLETED",
          completedAt: new Date(),
          createdBy: clinic.userId,
        }),
      });
    });

    const row = (await queue()).find((entry) => entry.appointmentId === appointmentId);
    // Q15 lets the same doctor hold an abandoned draft and a finished visit. "Finished" is the fact
    // reception acts on, and reporting DRAFT here would send them to interrupt a consultation that
    // is over.
    expect(row?.visitStatus).toBe("COMPLETED");
  });

  test("the row carries no clinical content, only the status", async () => {
    const appointmentId = await appointmentNow();
    await withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) => {
      await tx.visit.create({
        data: injected({
          patientId: clinic.patientId,
          doctorId: clinic.doctorId,
          appointmentId,
          status: "DRAFT",
          diagnosis: "SENTINEL-DIAGNOSIS-QUEUE",
          doctorNotes: "SENTINEL-NOTES-QUEUE",
          createdBy: clinic.userId,
        }),
      });
    });

    const response = await fetch(`${baseUrl}/queue/today?date=${today}`, {
      headers: { authorization: `Bearer ${receptionToken}` },
    });
    const raw = await response.text();
    // Asserted against the raw body, not a parsed field: a leak reaches the wire before it reaches
    // a property name anyone thought to check.
    expect(raw).not.toContain("SENTINEL-DIAGNOSIS-QUEUE");
    expect(raw).not.toContain("SENTINEL-NOTES-QUEUE");
    expect(raw).toContain("visitStatus");
  });
});
