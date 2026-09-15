import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Module, ValidationPipe } from "@nestjs/common";
import { APP_INTERCEPTOR, NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { ActorContextInterceptor } from "../../src/common/actor-context.interceptor.ts";
import { issueAccessToken } from "../../src/modules/auth/jwt.ts";
import { PatientsController } from "../../src/modules/patients/patients.controller.ts";
import { injected } from "../../src/prisma/injected.ts";
import { withTenant } from "../../src/prisma/with-tenant.ts";
import { actorFor, createTestUser, seedClinic, teardownClinic, type ClinicFixture } from "./fixtures.ts";

/**
 * «مرضاي» — R-B, ruled by the founder 2026-09-14.
 *
 * **The guard he attached to the ruling: a doctor cannot list or read a patient they never treated.**
 * Both halves are asserted here — the list, and a patient who is in nobody's list of this doctor's.
 *
 * The other line this file draws is between a **booking** and a **completed visit**. Reception
 * creates bookings, so "has an appointment with me" is a relationship anyone at the desk could
 * manufacture; it is the reason Level 2 was never gated on one, and it must not become a way into
 * this tab either.
 */

@Module({
  controllers: [PatientsController],
  providers: [{ provide: APP_INTERCEPTOR, useClass: ActorContextInterceptor }],
})
class MyPatientsTestModule {}

interface Listed {
  patients: { id: string; fullNameAr: string; visitCount: number; lastVisitAt: string }[];
  total: number;
}

describe("«مرضاي» — the patients a doctor has treated", () => {
  let app: NestExpressApplication;
  let baseUrl: string;
  let clinic: ClinicFixture;
  let doctorToken = "";
  let receptionToken = "";
  let colleagueDoctorId = "";

  /** Treated by the caller, twice. */
  let treatedId = "";
  /** Booked with the caller and never seen through: a booking is not treatment. */
  let bookedOnlyId = "";
  /** Treated by a colleague, never by the caller. */
  let strangerId = "";

  let slot = 0;
  const nextStart = (): Date => {
    slot += 1;
    return new Date(Date.now() - slot * 26 * 60 * 60_000);
  };

  const get = async (path: string, token: string): Promise<{ status: number; body: unknown }> => {
    const response = await fetch(`${baseUrl}${path}`, { headers: { authorization: `Bearer ${token}` } });
    const text = await response.text();
    return { status: response.status, body: text.length > 0 ? JSON.parse(text) : null };
  };

  const makePatient = async (fullNameAr: string): Promise<string> => {
    const id = randomUUID();
    await withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) => {
      await tx.patient.create({
        data: injected({
          id,
          fullNameAr,
          phoneE164: `+2015${id.replace(/-/g, "").slice(0, 7)}`,
          relationshipToContact: "SELF",
          status: "ACTIVE",
        }),
      });
    });
    return id;
  };

  /** An appointment, and optionally the completed visit that makes it treatment. */
  const seeing = async (
    patientId: string,
    doctorId: string,
    options: { completeTheVisit: boolean },
  ): Promise<void> => {
    await withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) => {
      const start = nextStart();
      const appointmentId = randomUUID();
      await tx.appointment.create({
        data: injected({
          id: appointmentId,
          patientId,
          doctorId,
          serviceId: clinic.serviceId,
          scheduledStart: start,
          scheduledEnd: new Date(start.getTime() + 20 * 60_000),
          status: "COMPLETED",
          source: "RECEPTION",
          createdBy: clinic.userId,
          updatedBy: clinic.userId,
        }),
      });
      if (!options.completeTheVisit) return;
      await tx.visit.create({
        data: injected({
          id: randomUUID(),
          patientId,
          doctorId,
          appointmentId,
          status: "COMPLETED",
          completedAt: new Date(start.getTime() + 20 * 60_000),
          createdBy: clinic.userId,
        }),
      });
    });
  };

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

    treatedId = await makePatient("سلمى عبد الرحمن");
    bookedOnlyId = await makePatient("هالة محمود");
    strangerId = await makePatient("نادية فؤاد");

    await seeing(treatedId, clinic.doctorId, { completeTheVisit: true });
    await seeing(treatedId, clinic.doctorId, { completeTheVisit: true });
    await seeing(bookedOnlyId, clinic.doctorId, { completeTheVisit: false });
    await seeing(strangerId, colleagueDoctorId, { completeTheVisit: true });

    doctorToken = await issueAccessToken({
      sub: clinic.userId,
      membershipId: clinic.membershipId,
      tenantId: clinic.tenantId,
      role: "DOCTOR",
    });

    const receptionMembershipId = randomUUID();
    await withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) => {
      await tx.membership.create({
        data: injected({
          id: receptionMembershipId,
          userId: clinic.userId,
          role: "RECEPTIONIST",
          status: "ACTIVE",
        }),
      });
    });
    receptionToken = await issueAccessToken({
      sub: clinic.userId,
      membershipId: receptionMembershipId,
      tenantId: clinic.tenantId,
      role: "RECEPTIONIST",
    });

    app = await NestFactory.create<NestExpressApplication>(MyPatientsTestModule, { logger: false });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.listen(0, "127.0.0.1");
    baseUrl = `http://127.0.0.1:${((app.getHttpServer() as Server).address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await app?.close();
    await teardownClinic(clinic);
  });

  test("the tab lists the patients this doctor has treated, with how often", async () => {
    const { status, body } = await get("/patients/mine", doctorToken);
    expect(status).toBe(200);
    const listed = body as Listed;

    const mine = listed.patients.find((patient) => patient.id === treatedId);
    expect(mine).toBeDefined();
    expect(mine?.visitCount).toBe(2);
    expect(Date.parse(mine?.lastVisitAt ?? "")).not.toBeNaN();
  });

  /** **The guard, first half: a doctor cannot LIST a patient they never treated.** */
  test("a colleague's patient is not in the list, and neither is a booking never seen through", async () => {
    const { body } = await get("/patients/mine", doctorToken);
    const ids = (body as Listed).patients.map((patient) => patient.id);

    expect(ids).toContain(treatedId);
    expect(ids).not.toContain(strangerId);
    // A booking is not treatment. Reception creates bookings; treatment is a visit that finished.
    expect(ids).not.toContain(bookedOnlyId);
  });

  test("search narrows within the doctor's own patients, and never reaches outside them", async () => {
    const mine = await get(`/patients/mine?q=${encodeURIComponent("سلمى")}`, doctorToken);
    expect((mine.body as Listed).patients.map((patient) => patient.id)).toEqual([treatedId]);

    // The same name search run against the clinic would find her; run here it finds nobody,
    // because this doctor has never treated her.
    const stranger = await get(`/patients/mine?q=${encodeURIComponent("نادية")}`, doctorToken);
    expect(stranger.status).toBe(200);
    expect((stranger.body as Listed).patients).toEqual([]);
    expect((stranger.body as Listed).total).toBe(0);
  });

  test("a caller who is not a doctor has no such list", async () => {
    const { status, body } = await get("/patients/mine", receptionToken);
    expect(status).toBe(403);
    expect(body).toMatchObject({ code: "NOT_A_DOCTOR" });
  });

  test("the narrowing comes from the caller's own doctor row, never from the request", async () => {
    // `forbidNonWhitelisted` refuses a field the DTO never offered, so there is no way to ask for
    // somebody else's list — the attempt is a 400 rather than a filter that might be honoured.
    const { status } = await get(`/patients/mine?doctorId=${colleagueDoctorId}`, doctorToken);
    expect(status).toBe(400);
  });
});
