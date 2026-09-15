import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Module, ValidationPipe } from "@nestjs/common";
import { APP_INTERCEPTOR, NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { ActorContextInterceptor } from "../../src/common/actor-context.interceptor.ts";
import {
  bookAppointment,
  findAvailableSlots,
  type CallerContext,
} from "../../src/modules/appointments/appointments.service.ts";
import { issueAccessToken } from "../../src/modules/auth/jwt.ts";
import { ClinicalController } from "../../src/modules/clinical/clinical.controller.ts";
import { checkIn } from "../../src/modules/queue/queue.service.ts";
import { prisma } from "../../src/prisma/client.ts";
import { injected } from "../../src/prisma/injected.ts";
import { withTenant } from "../../src/prisma/with-tenant.ts";
import { actorFor, createTestUser, seedClinic, teardownClinic, type ClinicFixture } from "./fixtures.ts";

/**
 * The two levels of clinical access — `PHASE-4.md`.
 *
 * The three cases the founder asked to see, asserted rather than demonstrated:
 *
 *   1. a doctor whose patient has ARRIVED   -> summary AND full history
 *   2. a doctor whose patient is only BOOKED -> summary, history refused
 *   3. reception                             -> neither, refused at the route
 *
 * Case 2 is the one that matters. "Has an appointment" is too weak a gate because **reception
 * creates bookings** — if a booking were enough, any record could be read by having someone book
 * it. "Is physically here and being seen" cannot be manufactured from a booking screen.
 */
@Module({
  controllers: [ClinicalController],
  providers: [{ provide: APP_INTERCEPTOR, useClass: ActorContextInterceptor }],
})
class ClinicalTestModule {}

describe("clinical access", () => {
  let app: NestExpressApplication;
  let baseUrl: string;
  let clinic: ClinicFixture;
  let caller: CallerContext;
  let doctorToken: string;
  let receptionToken: string;

  const DATE = "2026-09-01";
  const NOW = new Date("2026-08-25T06:00:00Z");

  async function book(): Promise<string> {
    const availability = await findAvailableSlots(caller, {
      doctorId: clinic.doctorId,
      serviceId: clinic.serviceId,
      date: DATE,
      channel: "STAFF",
      now: NOW,
    });
    if (!availability.ok) throw new Error("availability failed");
    const slot = availability.slots[0];
    if (slot === undefined) throw new Error("no slot free");
    const result = await bookAppointment(caller, {
      slotToken: slot.token,
      patientId: clinic.patientId,
      source: "RECEPTION",
      complaintSummary: "صداع مستمر",
      bookingNotes: null,
      now: NOW,
    });
    if (!result.ok) throw new Error(`booking failed: ${result.code}`);
    return result.appointmentId;
  }

  const get = async (path: string, token: string) => {
    const response = await fetch(`${baseUrl}${path}`, { headers: { authorization: `Bearer ${token}` } });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };

  beforeAll(async () => {
    clinic = await seedClinic();
    caller = { tenantId: clinic.tenantId, actor: actorFor(clinic.userId), role: "RECEPTIONIST", membershipId: clinic.membershipId };

    await withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) => {
      await tx.scheduleTemplate.create({
        data: injected({
          doctorId: clinic.doctorId,
          weekday: 2,
          startTime: new Date(Date.UTC(1970, 0, 1, 9, 0, 0)),
          endTime: new Date(Date.UTC(1970, 0, 1, 18, 0, 0)),
          validFrom: new Date(Date.UTC(2026, 0, 1)),
          validTo: null,
        }),
      });
      // A recorded allergy, so the summary has something to be right about.
      await tx.patientAllergy.create({
        data: injected({
          patientId: clinic.patientId,
          substance: "بنسلين",
          reaction: "طفح جلدي",
          severity: "SEVERE",
          recordedByUserId: clinic.userId,
        }),
      });
    });

    app = await NestFactory.create<NestExpressApplication>(ClinicalTestModule, { logger: false });
    app.set("trust proxy", 1);
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    await app.listen(0, "127.0.0.1");
    baseUrl = `http://127.0.0.1:${((app.getHttpServer() as Server).address() as AddressInfo).port}`;

    const own = await withTenant(clinic.tenantId, actorFor(clinic.userId), (tx) =>
      tx.doctor.findFirstOrThrow({ where: { id: clinic.doctorId }, select: { membershipId: true } }),
    );

    doctorToken = await issueAccessToken({
      sub: clinic.userId,
      membershipId: own.membershipId,
      tenantId: clinic.tenantId,
      role: "DOCTOR",
    });
    receptionToken = await issueAccessToken({
      sub: clinic.userId,
      membershipId: randomUUID(),
      tenantId: clinic.tenantId,
      role: "RECEPTIONIST",
    });
  });

  afterAll(async () => {
    if (app !== undefined) await app.close();
    if (clinic !== undefined) await teardownClinic(clinic);
    await prisma.$disconnect();
  });

  describe("case 1 — the doctor's own patient, arrived", () => {
    it("serves the summary and the full history", async () => {
      const id = await book();
      await checkIn(caller, { appointmentId: id, expectedStatus: "BOOKED", now: new Date() });

      const summary = await get(`/appointments/${id}/clinical-summary`, doctorToken);
      expect(summary.status).toBe(200);
      expect(summary.body["mayReadFullHistory"]).toBe(true);
      expect((summary.body["allergies"] as { substance: string }[])[0]?.substance).toBe("بنسلين");

      const history = await get(`/appointments/${id}/clinical-history`, doctorToken);
      expect(history.status).toBe(200);
      expect(Array.isArray(history.body["visits"])).toBe(true);
    });
  });

  describe("case 2 — the doctor's own patient, booked but not arrived", () => {
    it("serves the summary — a safety signal is never gated", async () => {
      const id = await book();
      const summary = await get(`/appointments/${id}/clinical-summary`, doctorToken);

      expect(summary.status).toBe(200);
      expect(summary.body["mayReadFullHistory"]).toBe(false);
      // The allergy is present even though the full record is not. That is the whole point of
      // Level 1: an allergy behind a gate is an allergy nobody reads.
      expect((summary.body["allergies"] as unknown[]).length).toBe(1);
    });

    it("refuses the full history, and says why rather than pretending it is missing", async () => {
      const id = await book();
      const history = await get(`/appointments/${id}/clinical-history`, doctorToken);

      // 409 not 404: the doctor can see this appointment on a screen. Withholding the content is
      // honest; pretending the row does not exist would be theatre.
      //
      // "Says why" is now the CODE saying why. The wire carries `{ code, params }` and no sentence
      // since 2026-09-06, so the assertion moved from the words to the thing the words came from --
      // NOT_PRESENT rather than NOT_FOUND is the whole distinction this test exists to hold.
      expect(history.status).toBe(409);
      expect({ code: history.body["code"], params: history.body["params"] }).toEqual({
        code: "NOT_PRESENT",
        params: {},
      });
    });
  });

  describe("case 3 — reception", () => {
    it("is refused both levels at the route, by the permission matrix", async () => {
      const id = await book();

      const summary = await get(`/appointments/${id}/clinical-summary`, receptionToken);
      const history = await get(`/appointments/${id}/clinical-history`, receptionToken);

      // visits.readContent is NONE for RECEPTIONIST, so PermissionGuard refuses before any handler
      // runs. Not a filtered response — reception never reaches the code that reads a diagnosis.
      expect(summary.status).toBe(403);
      expect(history.status).toBe(403);
    });

    it("still gets the non-clinical detail, including payment state and contact details", async () => {
      const id = await book();
      const detail = await get(`/appointments/${id}/detail`, receptionToken);

      expect(detail.status).toBe(200);
      expect(detail.body["phoneE164"]).toBeDefined();
      expect(detail.body["complaintSummary"]).toBe("صداع مستمر");
      // No payment row exists yet, and null is distinguishable from a zero balance on purpose.
      expect(detail.body["payment"]).toBeNull();

      // The negative that matters: nothing clinical is in this response at all.
      for (const forbidden of ["diagnosis", "examination", "doctorNotes", "allergies", "prescriptions"]) {
        expect(detail.body[forbidden]).toBeUndefined();
      }
    });
  });

  describe("cross-tenant and audit", () => {
    it("a cross-tenant appointment is 404 on every route", async () => {
      const other = await seedClinic();
      try {
        const otherCaller = { tenantId: other.tenantId, actor: actorFor(other.userId), role: "RECEPTIONIST", membershipId: other.membershipId };
        const foreign = await withTenant(other.tenantId, actorFor(other.userId), (tx) =>
          tx.appointment.findFirst({ where: { patientId: other.patientId }, select: { id: true } }),
        );
        void otherCaller;
        const id = foreign?.id ?? "00000000-0000-7000-8000-00000000dead";

        expect((await get(`/appointments/${id}/detail`, doctorToken)).status).toBe(404);
        expect((await get(`/appointments/${id}/clinical-summary`, doctorToken)).status).toBe(404);
      } finally {
        await teardownClinic(other);
      }
    });

    /**
     * **This `describe` was called "cross-tenant and audit" and contained no audit test.**
     *
     * `clinical.access.ts` calls `recordSensitiveRead` "the first real emitter of
     * `AuditAction.READ_SENSITIVE`", and `SCHEMA-DECISIONS.md` D24 rests on it: every cross-doctor
     * read is supposed to leave a row. Nothing asserted that a row was ever written, and the
     * guarantee was not held — the write was refused by RLS and the endpoint returned 500.
     *
     * So this is the audit half the name promised, written against the ordinary case: one doctor
     * opening the panel for a colleague's patient.
     */
    it("a doctor reading a colleague's patient gets a summary, and it is recorded", async () => {
      const appointmentId = await book();

      const colleagueUserId = await createTestUser();
      let colleagueMembershipId = "";
      await withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) => {
        colleagueMembershipId = randomUUID();
        await tx.membership.create({
          data: injected({
            id: colleagueMembershipId,
            userId: colleagueUserId,
            role: "DOCTOR",
            status: "ACTIVE",
          }),
        });
        await tx.doctor.create({
          data: injected({
            id: randomUUID(),
            membershipId: colleagueMembershipId,
            specialty: "General",
            licenseNumber: `LIC-${colleagueMembershipId.replace(/-/g, "").slice(0, 8)}`,
            title: "Dr.",
          }),
        });
      });
      const colleagueToken = await issueAccessToken({
        sub: colleagueUserId,
        membershipId: colleagueMembershipId,
        tenantId: clinic.tenantId,
        role: "DOCTOR",
      });

      const before = await withTenant(clinic.tenantId, actorFor(clinic.userId), (tx) =>
        tx.auditLog.count({ where: { action: "READ_SENSITIVE", entityId: clinic.patientId } }),
      );

      const response = await get(`/appointments/${appointmentId}/clinical-summary`, colleagueToken);
      expect(response.status).toBe(200);

      const after = await withTenant(clinic.tenantId, actorFor(clinic.userId), (tx) =>
        tx.auditLog.count({ where: { action: "READ_SENSITIVE", entityId: clinic.patientId } }),
      );
      // A summary that was served is a summary that was recorded, or D24's guarantee is a comment.
      expect(after).toBe(before + 1);

      const row = await withTenant(clinic.tenantId, actorFor(clinic.userId), (tx) =>
        tx.auditLog.findFirst({
          where: { action: "READ_SENSITIVE", entityId: clinic.patientId },
          orderBy: { createdAt: "desc" },
          select: { tenantId: true, actorUserId: true, newState: true },
        }),
      );
      // The tenant must be stamped. A NULL here is a row no tenant session can ever read back,
      // which is the same as not having written it.
      expect(row?.tenantId).toBe(clinic.tenantId);
      expect(row?.actorUserId).toBe(colleagueUserId);
      expect(row?.newState).toMatchObject({ level: "SUMMARY" });
    });
  });
});
