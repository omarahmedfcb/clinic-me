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
import { calendarDayIn } from "../../src/modules/appointments/domain/zoned-time.ts";
import {
  actorFor,
  createTestUser,
  seedClinic,
  teardownClinic,
  type ClinicFixture,
} from "./fixtures.ts";

/**
 * Finishing a visit, correcting a finished one, and the procedures a visit carries — `PHASE-4.md`
 * Q6, Q24 and Q25. `PHASE-4-PLAN.md` PR 4.
 *
 * Two assertions carry this file. **The append-only trigger on `visit_revisions` is exercised for
 * the first time since it was written** — nothing has ever inserted through it, and an untested
 * trigger is indistinguishable from an absent one. And **a price snapshot is asserted to survive a
 * re-price**, which is the failure that is invisible until an admin edits the catalogue.
 */

@Module({
  controllers: [ClinicalController],
  providers: [{ provide: APP_INTERCEPTOR, useClass: ActorContextInterceptor }],
})
class VisitCompletionTestModule {}

/**
 * A distinct past half-hour per fixture appointment.
 *
 * `no_double_booking` is a live exclusion constraint, so two appointments at the same instant for
 * one doctor are refused — correctly. The past keeps them clear of the follow-up slots the engine
 * offers, which are all in the future.
 */
let fixtureSlot = 0;
function nextFixtureSlot(): Date {
  fixtureSlot += 1;
  return new Date(Date.now() - fixtureSlot * 24 * 60 * 60_000);
}

describe("finishing a visit", () => {
  let app: NestExpressApplication;
  let baseUrl: string;
  let clinic: ClinicFixture;
  let doctorToken = "";

  const call = async (method: string, path: string, body?: unknown): Promise<Response> =>
    fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${doctorToken}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  /** An appointment already in consultation, priced as reception quoted it. */
  const appointmentFor = async (quotedPriceMinor: number | null): Promise<string> => {
    const id = randomUUID();
    await withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) => {
      const start = nextFixtureSlot();
      await tx.appointment.create({
        data: injected({
          id,
          patientId: clinic.patientId,
          doctorId: clinic.doctorId,
          serviceId: clinic.serviceId,
          quotedPriceMinor,
          scheduledStart: start,
          scheduledEnd: new Date(start.getTime() + 30 * 60_000),
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

  const openDraft = async (appointmentId: string): Promise<{ id: string; revision: number }> => {
    const response = await call("POST", `/appointments/${appointmentId}/visit/draft`);
    expect(response.status).toBe(201);
    return (await response.json()) as { id: string; revision: number };
  };

  beforeAll(async () => {
    clinic = await seedClinic();

    // Every weekday, so any follow-up date the clock lands on has bookable time behind it. The
    // engine is what decides availability here; the fixture only has to stop being the reason.
    await withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) => {
      for (let weekday = 0; weekday < 7; weekday += 1) {
        await tx.scheduleTemplate.create({
          data: injected({
            doctorId: clinic.doctorId,
            weekday,
            startTime: new Date(Date.UTC(1970, 0, 1, 0, 0, 0)),
            endTime: new Date(Date.UTC(1970, 0, 1, 23, 30, 0)),
            validFrom: new Date(Date.UTC(2026, 0, 1)),
            validTo: null,
          }),
        });
      }
    });

    doctorToken = await issueAccessToken({
      sub: clinic.userId,
      membershipId: clinic.membershipId,
      tenantId: clinic.tenantId,
      role: "DOCTOR",
    });

    app = await NestFactory.create<NestExpressApplication>(VisitCompletionTestModule, { logger: false });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.listen(0);
    baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await app?.close();
    await teardownClinic(clinic);
    await prisma.$disconnect();
  });

  test("completing the visit completes the appointment, and both are one act", async () => {
    const appointmentId = await appointmentFor(10000);
    const draft = await openDraft(appointmentId);

    const response = await call("POST", `/appointments/${appointmentId}/visit/${draft.id}/complete`, {
      expectedRevision: draft.revision,
    });
    expect(response.status).toBe(201);
    const completed = (await response.json()) as { appointmentStatus: string; completedAt: string };
    expect(completed.appointmentStatus).toBe("COMPLETED");

    await withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) => {
      const visit = await tx.visit.findFirstOrThrow({ where: { id: draft.id } });
      expect(visit.status).toBe("COMPLETED");
      expect(visit.completedAt).not.toBeNull();

      const appointment = await tx.appointment.findFirstOrThrow({ where: { id: appointmentId } });
      expect(appointment.status).toBe("COMPLETED");
      expect(appointment.consultationEndedAt).not.toBeNull();

      // The status change is in the append-only history, not merely on the row.
      const events = await tx.appointmentEvent.findMany({
        where: { appointmentId, eventType: "STATUS_CHANGED" },
      });
      expect(events.map((event) => event.toStatus)).toContain("COMPLETED");
    });
  });

  test("a completion carrying a stale revision is refused, and the visit stays a draft", async () => {
    const appointmentId = await appointmentFor(10000);
    const draft = await openDraft(appointmentId);
    await call("PATCH", `/appointments/${appointmentId}/visit/draft/${draft.id}`, {
      expectedRevision: draft.revision,
      diagnosis: "written from the other tab",
    });

    const response = await call("POST", `/appointments/${appointmentId}/visit/${draft.id}/complete`, {
      expectedRevision: draft.revision,
    });
    expect(response.status).toBe(409);
    expect(((await response.json()) as { code: string }).code).toBe("STALE_REVISION");

    await withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) => {
      const visit = await tx.visit.findFirstOrThrow({ where: { id: draft.id } });
      expect(visit.status).toBe("DRAFT");
      expect(visit.diagnosis).toBe("written from the other tab");
    });
  });

  test("a second COMPLETED visit for one appointment is refused, and the database is the arbiter", async () => {
    const appointmentId = await appointmentFor(10000);
    const draft = await openDraft(appointmentId);
    await call("POST", `/appointments/${appointmentId}/visit/${draft.id}/complete`, {
      expectedRevision: draft.revision,
    });

    // Not through the service, which could refuse on its own reading. Straight at the table, where
    // only the partial unique index from PR 1 can say no.
    await expect(
      withTenant(clinic.tenantId, actorFor(clinic.userId), (tx) =>
        tx.visit.create({
          data: injected({
            patientId: clinic.patientId,
            doctorId: clinic.doctorId,
            appointmentId,
            status: "COMPLETED",
            createdBy: clinic.userId,
          }),
        }),
      ),
    ).rejects.toThrow();
  });

  test("the follow-up interval becomes a real appointment on the doctor's diary", async () => {
    const appointmentId = await appointmentFor(10000);
    const draft = await openDraft(appointmentId);

    const response = await call("POST", `/appointments/${appointmentId}/visit/${draft.id}/complete`, {
      expectedRevision: draft.revision,
      followUpIntervalDays: 14,
    });
    expect(response.status).toBe(201);
    const completed = (await response.json()) as {
      followUpDate: string;
      followUpAppointmentId: string | null;
    };
    expect(completed.followUpAppointmentId).not.toBeNull();

    await withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) => {
      const booked = await tx.appointment.findFirstOrThrow({
        where: { id: completed.followUpAppointmentId as string },
      });
      expect(booked.status).toBe("BOOKED");
      expect(booked.source).toBe("DOCTOR");
      expect(booked.patientId).toBe(clinic.patientId);
      // The clinic's own day, not UTC's: the tenant is Africa/Cairo and a 00:30 local slot is the
      // previous calendar day in UTC.
      const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: clinic.tenantId } });
      expect(calendarDayIn(booked.scheduledStart, tenant.timezone)).toBe(completed.followUpDate);

      const visit = await tx.visit.findFirstOrThrow({ where: { id: draft.id } });
      expect(visit.followUpIntervalDays).toBe(14);
    });
  });

  test("a follow-up on a day the doctor does not work still completes the visit, and says so", async () => {
    const appointmentId = await appointmentFor(10000);
    const draft = await openDraft(appointmentId);

    // Beyond every template's validity, so the engine offers nothing rather than the fixture
    // pretending the doctor is busy.
    const response = await call("POST", `/appointments/${appointmentId}/visit/${draft.id}/complete`, {
      expectedRevision: draft.revision,
      followUpDate: "2025-01-01",
    });
    expect(response.status).toBe(201);
    const completed = (await response.json()) as { followUpAppointmentId: string | null };
    expect(completed.followUpAppointmentId).toBeNull();

    await withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) => {
      expect((await tx.visit.findFirstOrThrow({ where: { id: draft.id } })).status).toBe("COMPLETED");
    });
  });
});

describe("what was done at the visit", () => {
  let app: NestExpressApplication;
  let baseUrl: string;
  let clinic: ClinicFixture;
  let doctorToken = "";

  const call = async (method: string, path: string, body?: unknown): Promise<Response> =>
    fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${doctorToken}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  const appointmentFor = async (quotedPriceMinor: number | null): Promise<string> => {
    const id = randomUUID();
    await withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) => {
      const start = nextFixtureSlot();
      await tx.appointment.create({
        data: injected({
          id,
          patientId: clinic.patientId,
          doctorId: clinic.doctorId,
          serviceId: clinic.serviceId,
          quotedPriceMinor,
          scheduledStart: start,
          scheduledEnd: new Date(start.getTime() + 30 * 60_000),
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

  const openDraft = async (appointmentId: string): Promise<{ id: string; revision: number }> => {
    const response = await call("POST", `/appointments/${appointmentId}/visit/draft`);
    expect(response.status).toBe(201);
    return (await response.json()) as { id: string; revision: number };
  };

  interface Line {
    id: string;
    serviceId: string;
    quantity: number;
    unitPriceMinor: number | null;
    source: string;
  }

  beforeAll(async () => {
    clinic = await seedClinic();
    doctorToken = await issueAccessToken({
      sub: clinic.userId,
      membershipId: clinic.membershipId,
      tenantId: clinic.tenantId,
      role: "DOCTOR",
    });
    app = await NestFactory.create<NestExpressApplication>(VisitCompletionTestModule, { logger: false });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.listen(0);
    baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await app?.close();
    await teardownClinic(clinic);
    await prisma.$disconnect();
  });

  test("the consultation reception booked is the visit's first line, at the price it was quoted at", async () => {
    const appointmentId = await appointmentFor(7500);
    const draft = await openDraft(appointmentId);

    // The catalogue moves after the quote. Nothing about this visit may move with it.
    await withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) => {
      await tx.service.update({ where: { id: clinic.serviceId }, data: { priceMinor: 99999 } });
    });

    const response = await call("GET", `/appointments/${appointmentId}/visit/${draft.id}/procedures`);
    expect(response.status).toBe(200);
    const lines = (await response.json()) as Line[];
    expect(lines).toHaveLength(1);
    expect(lines[0]?.source).toBe("RECEPTION");
    expect(lines[0]?.unitPriceMinor).toBe(7500);
  });

  test("an appointment with no recorded quote gives a line with no price, never a zero", async () => {
    const appointmentId = await appointmentFor(null);
    const draft = await openDraft(appointmentId);
    const lines = (await (
      await call("GET", `/appointments/${appointmentId}/visit/${draft.id}/procedures`)
    ).json()) as Line[];
    expect(lines[0]?.unitPriceMinor).toBeNull();
  });

  test("a doctor-added procedure keeps the price it was recorded at when the service is re-priced", async () => {
    const appointmentId = await appointmentFor(7500);
    const draft = await openDraft(appointmentId);

    let extraServiceId = "";
    await withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) => {
      extraServiceId = randomUUID();
      await tx.service.create({
        data: injected({
          id: extraServiceId,
          nameAr: "خياطة جرح",
          nameEn: "Suture",
          type: "PROCEDURE",
          durationMinutes: 15,
          priceMinor: 25000,
        }),
      });
    });

    const added = await call("POST", `/appointments/${appointmentId}/visit/${draft.id}/procedures`, {
      serviceId: extraServiceId,
      quantity: 2,
    });
    expect(added.status).toBe(201);

    await withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) => {
      await tx.service.update({ where: { id: extraServiceId }, data: { priceMinor: 40000 } });
    });

    const lines = (await (
      await call("GET", `/appointments/${appointmentId}/visit/${draft.id}/procedures`)
    ).json()) as Line[];
    const doctorLine = lines.find((line) => line.source === "DOCTOR");
    expect(doctorLine?.unitPriceMinor).toBe(25000);
    expect(doctorLine?.quantity).toBe(2);
  });

  test("reception's own line is not removable", async () => {
    const appointmentId = await appointmentFor(7500);
    const draft = await openDraft(appointmentId);

    let extraServiceId = "";
    await withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) => {
      extraServiceId = randomUUID();
      await tx.service.create({
        data: injected({
          id: extraServiceId,
          nameAr: "حقن",
          nameEn: "Injection",
          type: "PROCEDURE",
          durationMinutes: 10,
          priceMinor: 5000,
        }),
      });
    });
    await call("POST", `/appointments/${appointmentId}/visit/${draft.id}/procedures`, {
      serviceId: extraServiceId,
    });

    const before = (await (
      await call("GET", `/appointments/${appointmentId}/visit/${draft.id}/procedures`)
    ).json()) as Line[];
    const receptionLine = before.find((line) => line.source === "RECEPTION");
    const doctorLine = before.find((line) => line.source === "DOCTOR");

    const refusedReception = await call(
      "DELETE",
      `/appointments/${appointmentId}/visit/${draft.id}/procedures/${receptionLine?.id}`,
    );
    expect(refusedReception.status).toBe(404);

    const removed = await call(
      "DELETE",
      `/appointments/${appointmentId}/visit/${draft.id}/procedures/${doctorLine?.id}`,
    );
    expect(removed.status).toBe(200);
    expect(((await removed.json()) as Line[]).some((line) => line.source === "DOCTOR")).toBe(false);
  });

  test("a finished visit's lines are frozen, even with the patient back in the room", async () => {
    const appointmentId = await appointmentFor(7500);
    const draft = await openDraft(appointmentId);
    const before = (await (
      await call("GET", `/appointments/${appointmentId}/visit/${draft.id}/procedures`)
    ).json()) as Line[];

    await call("POST", `/appointments/${appointmentId}/visit/${draft.id}/complete`, {
      expectedRevision: draft.revision,
    });

    // The patient is with this doctor again, so access is not what is being tested here — the
    // refusal has to come from the visit being finished.
    await withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) => {
      const start = nextFixtureSlot();
      await tx.appointment.create({
        data: injected({
          patientId: clinic.patientId,
          doctorId: clinic.doctorId,
          serviceId: clinic.serviceId,
          scheduledStart: start,
          scheduledEnd: new Date(start.getTime() + 30 * 60_000),
          status: "IN_CONSULTATION",
          source: "RECEPTION",
          createdBy: clinic.userId,
          updatedBy: clinic.userId,
        }),
      });
    });

    const refused = await call(
      "DELETE",
      `/appointments/${appointmentId}/visit/${draft.id}/procedures/${before[0]?.id}`,
    );
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { code: string }).code).toBe("ALREADY_COMPLETED");
  });
});

describe("correcting a finished visit", () => {
  let app: NestExpressApplication;
  let baseUrl: string;
  let clinic: ClinicFixture;
  let doctorToken = "";

  const call = async (method: string, path: string, body?: unknown): Promise<Response> =>
    fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${doctorToken}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  const completedVisit = async (): Promise<{ appointmentId: string; visitId: string }> => {
    const appointmentId = randomUUID();
    await withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) => {
      const start = nextFixtureSlot();
      await tx.appointment.create({
        data: injected({
          id: appointmentId,
          patientId: clinic.patientId,
          doctorId: clinic.doctorId,
          serviceId: clinic.serviceId,
          quotedPriceMinor: 10000,
          scheduledStart: start,
          scheduledEnd: new Date(start.getTime() + 30 * 60_000),
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
    const draft = (await (
      await call("POST", `/appointments/${appointmentId}/visit/draft`)
    ).json()) as { id: string; revision: number };
    const saved = await call("PATCH", `/appointments/${appointmentId}/visit/draft/${draft.id}`, {
      expectedRevision: draft.revision,
      diagnosis: "التهاب الجيوب الأنفية",
    });
    expect(saved.status).toBe(200);
    const finished = await call("POST", `/appointments/${appointmentId}/visit/${draft.id}/complete`, {
      expectedRevision: draft.revision + 1,
    });
    expect(finished.status).toBe(201);
    // Nothing is put back in the room. Completion ends the appointment, and what carries the
    // amendment tests below is Q6's 24-hour grace window for the doctor who finished it (D35) —
    // which is the case the ruling exists for: remembering a sentence a minute after ending a visit.
    return { appointmentId, visitId: draft.id };
  };

  beforeAll(async () => {
    clinic = await seedClinic();
    doctorToken = await issueAccessToken({
      sub: clinic.userId,
      membershipId: clinic.membershipId,
      tenantId: clinic.tenantId,
      role: "DOCTOR",
    });
    app = await NestFactory.create<NestExpressApplication>(VisitCompletionTestModule, { logger: false });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.listen(0);
    baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await app?.close();
    await teardownClinic(clinic);
    await prisma.$disconnect();
  });

  test("an amendment keeps the original, names a reason, and moves the record on", async () => {
    const { appointmentId, visitId } = await completedVisit();

    const response = await call("POST", `/appointments/${appointmentId}/visit/${visitId}/amend`, {
      reason: "أضفت تشخيصًا ثانيًا بعد مراجعة الأشعة",
      diagnosis: "التهاب الجيوب الأنفية المزمن",
    });
    expect(response.status).toBe(201);

    await withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) => {
      const visit = await tx.visit.findFirstOrThrow({ where: { id: visitId } });
      expect(visit.diagnosis).toBe("التهاب الجيوب الأنفية المزمن");

      const revisions = await tx.visitRevision.findMany({ where: { visitId } });
      expect(revisions).toHaveLength(1);
      expect(revisions[0]?.reason).toBe("أضفت تشخيصًا ثانيًا بعد مراجعة الأشعة");
      expect(revisions[0]?.changedFields).toEqual(["diagnosis"]);
      // Byte-identical: clinical text is never normalised, in the record or in its history.
      expect((revisions[0]?.previousValues as { diagnosis: string }).diagnosis).toBe(
        "التهاب الجيوب الأنفية",
      );
    });
  });

  test("an amendment with no reason is refused, and nothing is written", async () => {
    const { appointmentId, visitId } = await completedVisit();
    const response = await call("POST", `/appointments/${appointmentId}/visit/${visitId}/amend`, {
      reason: "   ",
      diagnosis: "something else",
    });
    expect(response.status).toBe(422);
    expect(((await response.json()) as { code: string }).code).toBe("REASON_REQUIRED");

    await withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) => {
      expect(await tx.visitRevision.count({ where: { visitId } })).toBe(0);
      expect((await tx.visit.findFirstOrThrow({ where: { id: visitId } })).diagnosis).toBe(
        "التهاب الجيوب الأنفية",
      );
    });
  });

  test("the window closes after twenty-four hours, and Q18's rule applies again", async () => {
    const { appointmentId, visitId } = await completedVisit();

    // Nothing says the patient is present: every other live appointment in this fixture belongs to
    // a sibling test and is closed here, so the only thing that could admit the caller is the window.
    await withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) => {
      await tx.appointment.updateMany({
        where: { patientId: clinic.patientId, status: { in: ["ARRIVED", "WAITING", "IN_CONSULTATION"] } },
        data: { status: "COMPLETED" },
      });
      // Aged past the window rather than waiting a day for it: the boundary is measured from
      // `completed_at`, so moving that is the same experiment as moving the clock.
      await tx.visit.update({
        where: { id: visitId },
        data: { completedAt: new Date(Date.now() - 25 * 60 * 60 * 1000) },
      });
    });

    const response = await call("POST", `/appointments/${appointmentId}/visit/${visitId}/amend`, {
      reason: "remembered a sentence, a day late",
      doctorNotes: "x",
    });
    expect(response.status).toBe(409);
    expect(((await response.json()) as { code: string }).code).toBe("NOT_PRESENT");
  });

  test("a second doctor is refused inside the window", async () => {
    // The guard the founder asked for with the ruling: the window relaxes presence, and does not
    // widen who may reach the record. That is the permanent-access accumulation Q18 rejected.
    const { appointmentId, visitId } = await completedVisit();

    const colleagueUserId = await createTestUser();
    let colleagueToken = "";
    await withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) => {
      const membershipId = randomUUID();
      await tx.membership.create({
        data: injected({ id: membershipId, userId: colleagueUserId, role: "DOCTOR", status: "ACTIVE" }),
      });
      await tx.doctor.create({
        data: injected({
          id: randomUUID(),
          membershipId,
          specialty: "General",
          licenseNumber: `LIC-${membershipId.slice(0, 8)}`,
          title: "Dr.",
        }),
      });
      colleagueToken = await issueAccessToken({
        sub: colleagueUserId,
        membershipId,
        tenantId: clinic.tenantId,
        role: "DOCTOR",
      });
    });

    const response = await fetch(
      `${baseUrl}/appointments/${appointmentId}/visit/${visitId}/amend`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${colleagueToken}`, "content-type": "application/json" },
        body: JSON.stringify({ reason: "not mine to correct", doctorNotes: "x" }),
      },
    );
    expect(response.status).toBe(409);
    expect(((await response.json()) as { code: string }).code).toBe("NOT_PRESENT");

    // And the record is untouched — a refusal that wrote would be the worst of both.
    await withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) => {
      expect(await tx.visitRevision.count({ where: { visitId } })).toBe(0);
    });
  });

  test("a draft is written into, not amended", async () => {
    const appointmentId = randomUUID();
    await withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) => {
      const start = nextFixtureSlot();
      await tx.appointment.create({
        data: injected({
          id: appointmentId,
          patientId: clinic.patientId,
          doctorId: clinic.doctorId,
          serviceId: clinic.serviceId,
          scheduledStart: start,
          scheduledEnd: new Date(start.getTime() + 30 * 60_000),
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
    const draft = (await (
      await call("POST", `/appointments/${appointmentId}/visit/draft`)
    ).json()) as { id: string };

    const response = await call("POST", `/appointments/${appointmentId}/visit/${draft.id}/amend`, {
      reason: "a reason",
      diagnosis: "x",
    });
    expect(response.status).toBe(409);
    expect(((await response.json()) as { code: string }).code).toBe("NOT_COMPLETED");
  });

  test("the append-only trigger refuses to let a revision be edited or deleted (D5)", async () => {
    // The trigger has existed since 20260821193441_constraints and nothing had ever written a row
    // through it, so until now it was indistinguishable from an absent one. Exercised here on a
    // row this suite actually created, against the same application role the API uses.
    const { appointmentId, visitId } = await completedVisit();
    await call("POST", `/appointments/${appointmentId}/visit/${visitId}/amend`, {
      reason: "correcting the plan",
      treatmentPlan: "مضاد حيوي لمدة خمسة أيام",
    });

    const revisionId = await withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) => {
      const rows = await tx.visitRevision.findMany({ where: { visitId } });
      expect(rows).toHaveLength(1);
      return rows[0]?.id as string;
    });

    await expect(
      withTenant(clinic.tenantId, actorFor(clinic.userId), (tx) =>
        tx.visitRevision.update({ where: { id: revisionId }, data: { reason: "rewritten" } }),
      ),
    ).rejects.toThrow();

    await expect(
      withTenant(clinic.tenantId, actorFor(clinic.userId), (tx) =>
        tx.visitRevision.delete({ where: { id: revisionId } }),
      ),
    ).rejects.toThrow();

    await withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) => {
      const row = await tx.visitRevision.findFirstOrThrow({ where: { id: revisionId } });
      expect(row.reason).toBe("correcting the plan");
    });
  });
});
