import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Module, ValidationPipe } from "@nestjs/common";
import { APP_INTERCEPTOR, NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { ActorContextInterceptor } from "../../src/common/actor-context.interceptor.ts";
import type { CallerContext } from "../../src/modules/appointments/appointments.service.ts";
import { issueAccessToken } from "../../src/modules/auth/jwt.ts";
import { ClinicalController } from "../../src/modules/clinical/clinical.controller.ts";
import { getClinicalHistory } from "../../src/modules/clinical/clinical.service.ts";
import { TRANSFER_ACCESS_WINDOW_DAYS, accessExpiresAt } from "../../src/modules/transfers/domain/transfer-state.ts";
import { prisma } from "../../src/prisma/client.ts";
import { injected } from "../../src/prisma/injected.ts";
import { withTenant } from "../../src/prisma/with-tenant.ts";
import { actorFor, createTestUser, seedClinic, teardownClinic, type ClinicFixture } from "./fixtures.ts";

/**
 * **Episode-scoped access expires — proven at the endpoint that returns clinical content.**
 *
 * The founder's requirement, and he was specific about where: *"a doctor granted episode access,
 * then the window lapses, must lose access to the clinical content — not just be unable to see the
 * patient in a list. Prove it at the endpoint that returns visit detail, since that's the one that
 * matters."* So every assertion here is against `GET /appointments/:id/clinical-history`, which is
 * the only endpoint that returns diagnosis, examination, plan and notes.
 *
 * ## The setup exists to close the other door
 *
 * Level 2 has two doors (`clinical.access.ts`): the patient is present on your own queue, or you
 * hold a live transfer grant. The receiving doctor here is deliberately **not** the appointment's
 * doctor and the patient is **not** present, so the presence door is shut and the grant is the only
 * thing that can open it. Without that the test would pass on presence alone and prove nothing —
 * the vacuous-guard shape this project keeps finding.
 *
 * ## Why the boundary is asserted twice, two different ways
 *
 * Over HTTP the server supplies its own clock, so lapse is simulated by moving the grant's
 * `decided_at` into the past — the anchor moves instead of the clock. That is the real endpoint and
 * the real refusal, which is what the founder asked for.
 *
 * The service-level pair moves **only the clock**, against one unchanged row, which is the cleaner
 * statement of the guarantee: same grant, same patient, same call, 200 then refused, and the single
 * variable is time.
 */
@Module({
  controllers: [ClinicalController],
  providers: [{ provide: APP_INTERCEPTOR, useClass: ActorContextInterceptor }],
})
class TransferAccessTestModule {}

describe("transfer access expires at the clinical-content endpoint", () => {
  let app: NestExpressApplication;
  let baseUrl: string;
  let clinic: ClinicFixture;
  let caller: CallerContext;

  /** The receiving doctor: not the appointment's doctor, so presence can never open the door. */
  let receivingDoctorId: string;
  let receivingUserId: string;
  /**
   * The receiving doctor's OWN membership. Held at this scope rather than left local to the
   * fixture, because a `CallerContext` has to describe ONE person: `resolveAccess` resolves the
   * doctor from `caller.membershipId`, so an actor belonging to one person paired with a
   * membership belonging to another resolves to the wrong doctor -- or to none -- and the
   * transfer grant then silently never applies. The boundary test below was written that way and
   * turned red the day the lookup stopped keying on `userId`, which is the only reason anyone
   * noticed.
   */
  let receivingMembershipId: string;
  let receivingToken: string;

  let appointmentId: string;

  const DAY = 24 * 60 * 60 * 1000;

  /** Long enough ago that the appointment is history and nobody is present. */
  const VISIT_AT = new Date("2026-08-04T09:00:00Z");

  const historyOver = async (token: string): Promise<Response> =>
    fetch(`${baseUrl}/appointments/${appointmentId}/clinical-history`, {
      headers: { authorization: `Bearer ${token}` },
    });

  /** Rewrites the one row's decision instant. The grant is otherwise untouched. */
  const setDecidedAt = async (decidedAt: Date): Promise<void> => {
    await withTenant(clinic.tenantId, actorFor(clinic.userId), (tx) =>
      tx.patientTransfer.updateMany({
        where: { patientId: clinic.patientId, toDoctorId: receivingDoctorId },
        data: { decidedAt },
      }),
    );
  };

  beforeAll(async () => {
    clinic = await seedClinic();
    caller = {
      tenantId: clinic.tenantId,
      actor: actorFor(clinic.userId),
      role: "DOCTOR",
      membershipId: clinic.membershipId,
    };
    receivingUserId = await createTestUser();

    await withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) => {
      receivingMembershipId = randomUUID();
      await tx.membership.create({
        data: injected({ id: receivingMembershipId, userId: receivingUserId, role: "DOCTOR", status: "ACTIVE" }),
      });
      receivingDoctorId = randomUUID();
      await tx.doctor.create({
        data: injected({
          id: receivingDoctorId,
          membershipId: receivingMembershipId,
          specialty: "Cardiology",
          licenseNumber: `LIC-${receivingDoctorId.replace(/-/g, "").slice(0, 8)}`,
          title: "Dr.",
        }),
      });

      // The originating doctor's appointment, already COMPLETED: nobody is present anywhere.
      appointmentId = randomUUID();
      await tx.appointment.create({
        data: injected({
          id: appointmentId,
          patientId: clinic.patientId,
          doctorId: clinic.doctorId,
          serviceId: clinic.serviceId,
          scheduledStart: VISIT_AT,
          scheduledEnd: new Date(VISIT_AT.getTime() + 30 * 60_000),
          status: "COMPLETED",
          source: "RECEPTION",
          createdBy: clinic.userId,
          updatedBy: clinic.userId,
        }),
      });

      // The clinical content that must disappear. Authored by the ORIGINATING doctor.
      await tx.visit.create({
        data: injected({
          id: randomUUID(),
          patientId: clinic.patientId,
          doctorId: clinic.doctorId,
          appointmentId,
          diagnosis: "Hypertension, stage 1",
          doctorNotes: "Started on amlodipine 5mg.",
          status: "COMPLETED",
          completedAt: VISIT_AT,
          createdBy: clinic.userId,
        }),
      });

      await tx.patientTransfer.create({
        data: injected({
          id: randomUUID(),
          patientId: clinic.patientId,
          fromDoctorId: clinic.doctorId,
          toDoctorId: receivingDoctorId,
          appointmentId,
          status: "ACCEPTED",
          initiatedByMembershipId: clinic.membershipId,
          decidedByMembershipId: receivingMembershipId,
          decidedAt: new Date(),
        }),
      });
    });

    receivingToken = await issueAccessToken({
      sub: receivingUserId,
      membershipId: receivingMembershipId,
      tenantId: clinic.tenantId,
      role: "DOCTOR",
    });

    app = await NestFactory.create<NestExpressApplication>(TransferAccessTestModule, { logger: false });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    await app.listen(0, "127.0.0.1");
    baseUrl = `http://127.0.0.1:${((app.getHttpServer() as Server).address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    if (app !== undefined) await app.close();
    await teardownClinic(clinic);
    await prisma.$disconnect();
  });

  describe("over HTTP, at the endpoint that returns visit detail", () => {
    test("inside the window the receiving doctor reads the clinical content", async () => {
      await setDecidedAt(new Date());

      const response = await historyOver(receivingToken);
      expect(response.status).toBe(200);

      // Non-vacuity: assert the content is actually there. A 200 carrying an empty record would
      // satisfy the status check while proving nothing about what the grant unlocks.
      const body = JSON.stringify(await response.json());
      expect(body).toContain("Hypertension, stage 1");
    });

    test("past the window the SAME fetch is refused, and the content is gone", async () => {
      await setDecidedAt(new Date(Date.now() - (TRANSFER_ACCESS_WINDOW_DAYS + 1) * DAY));

      const response = await historyOver(receivingToken);
      expect(response.status).not.toBe(200);

      expect(JSON.stringify(await response.json())).not.toContain("Hypertension, stage 1");
    });

    test("a lapsed grant is refused exactly as if no transfer had ever existed", async () => {
      await setDecidedAt(new Date(Date.now() - (TRANSFER_ACCESS_WINDOW_DAYS + 1) * DAY));
      const lapsed = await historyOver(receivingToken);

      await withTenant(clinic.tenantId, actorFor(clinic.userId), (tx) =>
        tx.patientTransfer.updateMany({
          where: { patientId: clinic.patientId, toDoctorId: receivingDoctorId },
          data: { status: "REJECTED" },
        }),
      );
      const never = await historyOver(receivingToken);

      expect(lapsed.status).toBe(never.status);
      expect(await lapsed.json()).toEqual(await never.json());

      await withTenant(clinic.tenantId, actorFor(clinic.userId), (tx) =>
        tx.patientTransfer.updateMany({
          where: { patientId: clinic.patientId, toDoctorId: receivingDoctorId },
          data: { status: "ACCEPTED" },
        }),
      );
    });
  });

  /**
   * The same guarantee with **only the clock moving** — one unchanged row, two instants either side
   * of its deadline. This is the statement the HTTP pair cannot quite make, because the server owns
   * its own clock.
   */
  describe("at the boundary, with only the clock moving", () => {
    test("200 before the deadline, refused at it", async () => {
      const decidedAt = new Date("2026-09-01T09:00:00Z");
      await setDecidedAt(decidedAt);

      const receivingCaller: CallerContext = {
        tenantId: clinic.tenantId,
        actor: actorFor(receivingUserId),
        role: "DOCTOR",
        // The receiving doctor's own membership, not the fixture doctor's. See its declaration.
        membershipId: receivingMembershipId,
      };

      const deadline = accessExpiresAt(decidedAt);

      const before = await getClinicalHistory(
        receivingCaller,
        "DOCTOR",
        appointmentId,
        new Date(deadline.getTime() - 1),
      );
      const at = await getClinicalHistory(receivingCaller, "DOCTOR", appointmentId, deadline);

      expect(before.ok).toBe(true);
      expect(at.ok).toBe(false);
    });
  });
});
