import { randomUUID } from "node:crypto";
import { Module, ValidationPipe } from "@nestjs/common";
import { APP_INTERCEPTOR, NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import type { AddressInfo } from "node:net";
import { ActorContextInterceptor } from "../../src/common/actor-context.interceptor.ts";
import { issueAccessToken } from "../../src/modules/auth/jwt.ts";
import { ClinicalController } from "../../src/modules/clinical/clinical.controller.ts";
import { prisma } from "../../src/prisma/client.ts";
import { injected } from "../../src/prisma/injected.ts";
import { withTenant } from "../../src/prisma/with-tenant.ts";
import { actorFor, createTestUser, seedClinic, teardownClinic, type ClinicFixture } from "./fixtures.ts";

/**
 * The visit write path — `PHASE-4.md` Q2, Q4, Q7, Q17. `PHASE-4-PLAN.md` PR 2.
 *
 * The assertion that carries this file is the compare-and-set one: a second client saving against a
 * revision that has moved is **refused**, and the first client's text is still on the row. A test
 * that only checked the refusal would pass against an implementation that refused *and* wrote.
 */

@Module({
  controllers: [ClinicalController],
  providers: [{ provide: APP_INTERCEPTOR, useClass: ActorContextInterceptor }],
})
class VisitDraftTestModule {}

describe("the visit draft write path", () => {
  let app: NestExpressApplication;
  let baseUrl: string;
  let clinic: ClinicFixture;

  let doctorToken = "";
  let receptionToken = "";
  let liveAppointmentId = "";

  const call = async (method: string, path: string, token: string, body?: unknown): Promise<Response> =>
    fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  const appointmentFor = async (doctorId: string, minutesFromNow: number): Promise<string> => {
    const id = randomUUID();
    await withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) => {
      const start = new Date(Date.now() + minutesFromNow * 60_000);
      await tx.appointment.create({
        data: injected({
          id,
          patientId: clinic.patientId,
          doctorId,
          serviceId: clinic.serviceId,
          scheduledStart: start,
          scheduledEnd: new Date(start.getTime() + 20 * 60_000),
          status: "IN_CONSULTATION",
          source: "RECEPTION",
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
    liveAppointmentId = await appointmentFor(clinic.doctorId, 0);

    doctorToken = await issueAccessToken({
      sub: clinic.userId,
      membershipId: clinic.membershipId,
      tenantId: clinic.tenantId,
      role: "DOCTOR",
    });

    const receptionUser = await createTestUser();
    let receptionMembership = "";
    await withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) => {
      receptionMembership = randomUUID();
      await tx.membership.create({
        data: injected({
          id: receptionMembership,
          userId: receptionUser,
          role: "RECEPTIONIST",
          status: "ACTIVE",
        }),
      });
    });
    receptionToken = await issueAccessToken({
      sub: receptionUser,
      membershipId: receptionMembership,
      tenantId: clinic.tenantId,
      role: "RECEPTIONIST",
    });

    app = await NestFactory.create<NestExpressApplication>(VisitDraftTestModule, { logger: false });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.listen(0);
    baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await app?.close();
    await teardownClinic(clinic);
    await prisma.$disconnect();
  });

  test("a doctor opens a draft, and opening it again resumes the same row", async () => {
    const first = await call("POST", `/appointments/${liveAppointmentId}/visit/draft`, doctorToken);
    expect(first.status).toBe(201);
    const opened = (await first.json()) as { id: string; revision: number; resumed: boolean };
    expect(opened.revision).toBe(0);
    expect(opened.resumed).toBe(false);

    // Q17: a second tab must resume, not create. Two rows would each accept saves and one would be
    // silently discarded at completion.
    const second = await call("POST", `/appointments/${liveAppointmentId}/visit/draft`, doctorToken);
    const resumed = (await second.json()) as { id: string; resumed: boolean };
    expect(resumed.id).toBe(opened.id);
    expect(resumed.resumed).toBe(true);

    const rows = await withTenant(clinic.tenantId, actorFor(clinic.userId), (tx) =>
      tx.visit.count({ where: { appointmentId: liveAppointmentId, status: "DRAFT" } }),
    );
    expect(rows).toBe(1);
  });

  test("a save increments the revision and stores the text byte-identical", async () => {
    const appointmentId = await appointmentFor(clinic.doctorId, 60);
    const draft = (await (await call("POST", `/appointments/${appointmentId}/visit/draft`, doctorToken)).json()) as { id: string; revision: number };

    // Deliberately carries the Arabic forms the name-search normalisation would fold. Clinical text
    // is stored byte-identical -- CLAUDE.md.
    const diagnosis = "التهاب الجيوب الأنفية الحاد  إصابة أوّلية";
    const saved = await call("PATCH", `/appointments/${appointmentId}/visit/draft/${draft.id}`, doctorToken, {
      expectedRevision: draft.revision,
      diagnosis,
    });
    expect(saved.status).toBe(200);
    const body = (await saved.json()) as { revision: number; diagnosis: string };
    expect(body.revision).toBe(draft.revision + 1);
    expect(body.diagnosis).toBe(diagnosis);

    const row = await withTenant(clinic.tenantId, actorFor(clinic.userId), (tx) =>
      tx.visit.findFirst({ where: { id: draft.id }, select: { diagnosis: true } }),
    );
    expect(row?.diagnosis).toBe(diagnosis);
  });

  test("the second of two clients is refused, and the first client's text survives", async () => {
    const appointmentId = await appointmentFor(clinic.doctorId, 120);
    const draft = (await (await call("POST", `/appointments/${appointmentId}/visit/draft`, doctorToken)).json()) as { id: string; revision: number };
    const url = `/appointments/${appointmentId}/visit/draft/${draft.id}`;

    const first = await call("PATCH", url, doctorToken, {
      expectedRevision: draft.revision,
      doctorNotes: "FIRST-CLIENT-TEXT",
    });
    expect(first.status).toBe(200);

    // The second client still holds the revision it was handed before the first save landed.
    const second = await call("PATCH", url, doctorToken, {
      expectedRevision: draft.revision,
      doctorNotes: "SECOND-CLIENT-TEXT",
    });
    expect(second.status).toBe(409);
    const refused = (await second.json()) as { code: string; params: { revision: number } };
    expect(refused.code).toBe("STALE_REVISION");
    // Carries the current revision so the client can refetch without a second round trip.
    expect(refused.params.revision).toBe(draft.revision + 1);

    // The half that matters: refusing and writing anyway would satisfy the assertions above.
    const row = await withTenant(clinic.tenantId, actorFor(clinic.userId), (tx) =>
      tx.visit.findFirst({ where: { id: draft.id }, select: { doctorNotes: true, revision: true } }),
    );
    expect(row?.doctorNotes).toBe("FIRST-CLIENT-TEXT");
    expect(row?.revision).toBe(draft.revision + 1);
  });

  test("reception is refused at the guard, on both routes", async () => {
    // visits.write is NONE for RECEPTIONIST, so this is refused before any handler runs -- not by a
    // branch inside one.
    const open = await call("POST", `/appointments/${liveAppointmentId}/visit/draft`, receptionToken);
    expect(open.status).toBe(403);

    const save = await call(
      "PATCH",
      `/appointments/${liveAppointmentId}/visit/draft/${randomUUID()}`,
      receptionToken,
      { expectedRevision: 0, diagnosis: "x" },
    );
    expect(save.status).toBe(403);
  });

  test("a save with no expectedRevision is rejected by the DTO, never treated as last-write-wins", async () => {
    const appointmentId = await appointmentFor(clinic.doctorId, 180);
    const draft = (await (await call("POST", `/appointments/${appointmentId}/visit/draft`, doctorToken)).json()) as { id: string; revision: number };

    const response = await call(
      "PATCH",
      `/appointments/${appointmentId}/visit/draft/${draft.id}`,
      doctorToken,
      { diagnosis: "no revision supplied" },
    );
    expect(response.status).toBe(400);
  });
});
