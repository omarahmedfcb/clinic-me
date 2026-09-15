import { randomUUID } from "node:crypto";
import { Module, ValidationPipe } from "@nestjs/common";
import { APP_INTERCEPTOR, NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import type { AddressInfo } from "node:net";
import { ActorContextInterceptor } from "../../src/common/actor-context.interceptor.ts";
import { issueAccessToken } from "../../src/modules/auth/jwt.ts";
import { ClinicalController } from "../../src/modules/clinical/clinical.controller.ts";
import { OpenVisitsController } from "../../src/modules/clinical/open-visits.controller.ts";
import { QueueController } from "../../src/modules/queue/queue.controller.ts";
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
 * Pausing a consultation, and the doctor's open-visit list — `PHASE-4.md` Q34 and Q35.
 *
 * Two assertions carry this file, and they are the two guards the rulings came with: **reception can
 * neither pause nor resume**, and **a paused draft is still refused to a second doctor**. The second
 * is the one worth stating: PAUSED counts as present so the author's own record does not close
 * underneath them, and a status that widens presence is exactly the shape that could widen it for
 * everybody.
 */

@Module({
  controllers: [QueueController, ClinicalController, OpenVisitsController],
  providers: [{ provide: APP_INTERCEPTOR, useClass: ActorContextInterceptor }],
})
class PauseTestModule {}

describe("a paused consultation", () => {
  let app: NestExpressApplication;
  let baseUrl: string;
  let clinic: ClinicFixture;
  let doctorToken = "";
  let receptionToken = "";
  let colleagueToken = "";
  let colleagueUserId = "";
  let colleagueDoctorId = "";

  const call = async (
    method: string,
    path: string,
    token: string,
    body?: unknown,
  ): Promise<Response> =>
    fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  const appointmentFor = async (doctorId: string): Promise<string> => {
    const id = randomUUID();
    await withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) => {
      const start = new Date();
      await tx.appointment.create({
        data: injected({
          id,
          patientId: clinic.patientId,
          doctorId,
          serviceId: clinic.serviceId,
          scheduledStart: start,
          scheduledEnd: new Date(start.getTime() + 30 * 60_000),
          status: "IN_CONSULTATION",
          source: "RECEPTION",
          // Several fixtures share an instant for one doctor; `allow_overlap` is the flag the
          // exclusion constraint itself exempts.
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

    doctorToken = await issueAccessToken({
      sub: clinic.userId,
      membershipId: clinic.membershipId,
      tenantId: clinic.tenantId,
      role: "DOCTOR",
    });

    const receptionUserId = await createTestUser();
    colleagueUserId = await createTestUser();
    let receptionMembershipId = "";
    let colleagueMembershipId = "";
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
      colleagueMembershipId = randomUUID();
      await tx.membership.create({
        data: injected({
          id: colleagueMembershipId,
          userId: colleagueUserId,
          role: "DOCTOR",
          status: "ACTIVE",
        }),
      });
      colleagueDoctorId = randomUUID();
      await tx.doctor.create({
        data: injected({
          id: colleagueDoctorId,
          membershipId: colleagueMembershipId,
          specialty: "General",
          licenseNumber: `LIC-${colleagueDoctorId.slice(0, 8)}`,
          title: "Dr.",
        }),
      });
    });

    receptionToken = await issueAccessToken({
      sub: receptionUserId,
      membershipId: receptionMembershipId,
      tenantId: clinic.tenantId,
      role: "RECEPTIONIST",
    });
    colleagueToken = await issueAccessToken({
      sub: colleagueUserId,
      membershipId: colleagueMembershipId,
      tenantId: clinic.tenantId,
      role: "DOCTOR",
    });

    app = await NestFactory.create<NestExpressApplication>(PauseTestModule, { logger: false });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.listen(0);
    baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await app?.close();
    await teardownClinic(clinic);
    await prisma.$disconnect();
  });

  test("the doctor pauses and resumes, and the reason lands in the history", async () => {
    const appointmentId = await appointmentFor(clinic.doctorId);

    const paused = await call("PATCH", `/queue/${appointmentId}/pause`, doctorToken, {
      expectedStatus: "IN_CONSULTATION",
      reason: "خرج لعمل أشعة",
    });
    expect(paused.status).toBe(200);
    expect(((await paused.json()) as { status: string }).status).toBe("PAUSED");

    const resumed = await call("PATCH", `/queue/${appointmentId}/resume`, doctorToken, {
      expectedStatus: "PAUSED",
    });
    expect(resumed.status).toBe(200);
    expect(((await resumed.json()) as { status: string }).status).toBe("IN_CONSULTATION");

    await withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) => {
      const events = await tx.appointmentEvent.findMany({
        where: { appointmentId, eventType: "STATUS_CHANGED" },
        orderBy: { createdAt: "asc" },
      });
      expect(events.map((event) => event.toStatus)).toEqual(["PAUSED", "IN_CONSULTATION"]);
      // The reason is clinician-authored, so it lives here and not on reception's queue row (Q14).
      expect(events[0]?.reason).toBe("خرج لعمل أشعة");
    });
  });

  test("reception can neither pause nor resume", async () => {
    // The guard the ruling came with. `visits.write` is NONE for RECEPTIONIST, so `PermissionGuard`
    // refuses before any handler runs — the matrix decides it, not a branch someone could delete.
    const appointmentId = await appointmentFor(clinic.doctorId);
    expect(
      (await call("PATCH", `/queue/${appointmentId}/pause`, receptionToken, { expectedStatus: "IN_CONSULTATION" }))
        .status,
    ).toBe(403);

    await call("PATCH", `/queue/${appointmentId}/pause`, doctorToken, { expectedStatus: "IN_CONSULTATION" });

    expect(
      (await call("PATCH", `/queue/${appointmentId}/resume`, receptionToken, { expectedStatus: "PAUSED" }))
        .status,
    ).toBe(403);
  });

  test("a colleague cannot pause a consultation that is not theirs", async () => {
    const appointmentId = await appointmentFor(clinic.doctorId);
    const refused = await call("PATCH", `/queue/${appointmentId}/pause`, colleagueToken, {
      expectedStatus: "IN_CONSULTATION",
    });
    // "The patient stepped out" is a fact only the doctor they stepped out on can state.
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { code: string }).code).toBe("NOT_PERMITTED");
  });

  test("the draft stays open and stays private while paused", async () => {
    const appointmentId = await appointmentFor(clinic.doctorId);
    const opened = await call("POST", `/appointments/${appointmentId}/visit/draft`, doctorToken);
    const draft = (await opened.json()) as { id: string; revision: number };

    await call("PATCH", `/queue/${appointmentId}/pause`, doctorToken, {
      expectedStatus: "IN_CONSULTATION",
    });

    // PAUSED counts as present for this doctor, so the record does not close underneath them.
    const resumedDraft = await call("POST", `/appointments/${appointmentId}/visit/draft`, doctorToken);
    expect(resumedDraft.status).toBe(201);
    const same = (await resumedDraft.json()) as { id: string; resumed: boolean };
    expect(same.id).toBe(draft.id);
    expect(same.resumed).toBe(true);

    const saved = await call("PATCH", `/appointments/${appointmentId}/visit/draft/${draft.id}`, doctorToken, {
      expectedRevision: draft.revision,
      diagnosis: "يُستكمل بعد الأشعة",
    });
    expect(saved.status).toBe(200);

    // And a second doctor is refused this draft (Q2, Q15). PAUSED widens presence for the doctor
    // whose consultation it is; it must not widen it for everybody, and `NOT_PRESENT` is the same
    // refusal a colleague would get on an unpaused consultation that is not theirs.
    const colleagueDraft = await call("POST", `/appointments/${appointmentId}/visit/draft`, colleagueToken);
    expect(colleagueDraft.status).toBe(409);
    expect(((await colleagueDraft.json()) as { code: string }).code).toBe("NOT_PRESENT");

    await withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) => {
      // And nothing was created for them either: a refusal that left a row behind would be worse.
      const theirs = await tx.visit.findMany({ where: { appointmentId, createdBy: colleagueUserId } });
      expect(theirs).toHaveLength(0);
    });
  });

  test("the open-visit list carries this doctor's consultations, paused ones included", async () => {
    const inConsultation = await appointmentFor(clinic.doctorId);
    const willPause = await appointmentFor(clinic.doctorId);
    const colleagues = await appointmentFor(colleagueDoctorId);

    await call("POST", `/appointments/${inConsultation}/visit/draft`, doctorToken);
    await call("PATCH", `/queue/${willPause}/pause`, doctorToken, { expectedStatus: "IN_CONSULTATION" });

    const response = await call("GET", "/visits/open", doctorToken);
    expect(response.status).toBe(200);
    const open = (await response.json()) as {
      appointmentId: string;
      status: string;
      visitId: string | null;
      patientName: string;
    }[];

    const ids = open.map((visit) => visit.appointmentId);
    expect(ids).toContain(inConsultation);
    // Q34: a patient at imaging is exactly the case a second tab exists for.
    expect(ids).toContain(willPause);
    // Never a colleague's consultation, whatever its status.
    expect(ids).not.toContain(colleagues);

    expect(open.find((visit) => visit.appointmentId === inConsultation)?.visitId).not.toBeNull();
    // No draft opened on the paused one, and null says so rather than inventing an id.
    expect(open.find((visit) => visit.appointmentId === willPause)?.visitId).toBeNull();
    expect(open[0]?.patientName).not.toBe("");
  });

  test("a consultation left open on another day is not a tab today (Q44)", async () => {
    // Reproduced before it was fixed: the review database held three IN_CONSULTATION rows for one
    // doctor spanning fifteen days, because **an open consultation that nobody completes stays open
    // forever**. The seed only ever makes one per doctor per reference day; the accumulation is a
    // property of the status, not of the fixture, and a real clinic will do the same.
    const stale = await appointmentFor(clinic.doctorId);
    await withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) => {
      const start = new Date(Date.now() - 6 * 24 * 60 * 60 * 1000);
      await tx.appointment.update({
        where: { id: stale },
        data: { scheduledStart: start, scheduledEnd: new Date(start.getTime() + 30 * 60_000) },
      });
    });

    const today = await appointmentFor(clinic.doctorId);

    const open = (await (await call("GET", "/visits/open", doctorToken)).json()) as {
      appointmentId: string;
    }[];
    const ids = open.map((visit) => visit.appointmentId);
    expect(ids).toContain(today);
    // Six days ago, still IN_CONSULTATION, and not a tab.
    expect(ids).not.toContain(stale);
  });

  test("reception has no open-visit list at all", async () => {
    // `visits.write` again: the list is about a doctor's own unfinished work, and reception has none.
    expect((await call("GET", "/visits/open", receptionToken)).status).toBe(403);
  });
});
