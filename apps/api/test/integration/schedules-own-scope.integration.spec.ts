import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Module, ValidationPipe } from "@nestjs/common";
import { APP_INTERCEPTOR, NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { ActorContextInterceptor } from "../../src/common/actor-context.interceptor.ts";
import { issueAccessToken } from "../../src/modules/auth/jwt.ts";
import { DoctorsController } from "../../src/modules/doctors/doctors.controller.ts";
import { SchedulesController } from "../../src/modules/schedules/schedules.controller.ts";
import { ServicesController } from "../../src/modules/services/services.controller.ts";
import { prisma } from "../../src/prisma/client.ts";
import { injected } from "../../src/prisma/injected.ts";
import { withTenant } from "../../src/prisma/with-tenant.ts";
import {
  actorFor,
  createTestUser,
  deleteTestUser,
  seedClinic,
  teardownClinic,
  type ClinicFixture,
} from "./fixtures.ts";

/**
 * Two things at once, because they are the same property seen from two directions.
 *
 * **`own` scoping** — PHASE-1.md's carried-forward item 2: "`own`-scoped routes ship with a test
 * that the query is scoped, not that the guard allowed the request." A DOCTOR holds `own` on
 * `doctorSchedules.manage`, so `PermissionGuard` lets every doctor through every one of these
 * routes. Whether *this* doctor may touch *that* schedule is decided in the service, against the
 * resource — and that is what is tested here.
 *
 * **Cross-tenant 404** — the same answer for a doctor in another clinic.
 *
 * Both are asserted as **indistinguishability**, not merely as a status code. A doctor asking
 * about a colleague's schedule, a doctor asking about another clinic's doctor, and anyone asking
 * about a UUID that never existed must all receive identical responses. A 403, or a differently
 * worded 404, would confirm that the id is real — the whole thing the convention prevents.
 */
@Module({
  controllers: [SchedulesController, DoctorsController, ServicesController],
  providers: [{ provide: APP_INTERCEPTOR, useClass: ActorContextInterceptor }],
})
class ScheduleTestModule {}

describe("schedules: own scoping and cross-tenant 404", () => {
  let app: NestExpressApplication;
  let baseUrl: string;
  let clinicA: ClinicFixture;
  let clinicB: ClinicFixture;

  /** A second doctor inside clinic A, so "another doctor" is not also "another tenant". */
  let colleagueDoctorId: string;
  let doctorToken: string;
  let adminToken: string;

  const NEVER_EXISTED = "00000000-0000-7000-8000-00000000dead";
  const colleagueUserIds: string[] = [];

  /**
   * A second doctor needs a second *user*: `memberships` is `UNIQUE (user_id, tenant_id)`, which
   * is the constraint that makes one person one membership per clinic (ARCHITECTURE.md §4).
   */
  async function addColleague(fixture: ClinicFixture): Promise<string> {
    const colleagueUserId = await createTestUser();
    colleagueUserIds.push(colleagueUserId);

    return withTenant(fixture.tenantId, actorFor(fixture.userId), async (tx) => {
      const membershipId = randomUUID();
      await tx.membership.create({
        data: injected({ id: membershipId, userId: colleagueUserId, role: "DOCTOR", status: "ACTIVE" }),
      });
      const doctorId = randomUUID();
      await tx.doctor.create({
        data: injected({
          id: doctorId,
          membershipId,
          specialty: "Dermatology",
          licenseNumber: `LIC-${doctorId.slice(0, 8)}`,
          title: "Dr.",
        }),
      });
      return doctorId;
    });
  }

  beforeAll(async () => {
    clinicA = await seedClinic();
    clinicB = await seedClinic();
    colleagueDoctorId = await addColleague(clinicA);

    app = await NestFactory.create<NestExpressApplication>(ScheduleTestModule, { logger: false });
    app.set("trust proxy", 1);
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();
    await app.listen(0, "127.0.0.1");
    baseUrl = `http://127.0.0.1:${((app.getHttpServer() as Server).address() as AddressInfo).port}`;

    // The doctor's own membership, resolved from the fixture's doctor row — `own` is decided by
    // comparing this against the target doctor's membership, so it must be the real one.
    const own = await withTenant(clinicA.tenantId, actorFor(clinicA.userId), (tx) =>
      tx.doctor.findFirstOrThrow({ where: { id: clinicA.doctorId }, select: { membershipId: true } }),
    );

    doctorToken = await issueAccessToken({
      sub: clinicA.userId,
      membershipId: own.membershipId,
      tenantId: clinicA.tenantId,
      role: "DOCTOR",
    });

    adminToken = await issueAccessToken({
      sub: clinicA.userId,
      membershipId: randomUUID(),
      tenantId: clinicA.tenantId,
      role: "ADMIN",
    });
  });

  afterAll(async () => {
    // `app` is undefined if beforeAll threw, and an unguarded close() then masks the real error
    // with a TypeError -- which is exactly what happened the first time this file ran.
    await app?.close();
    await teardownClinic(clinicA);
    await teardownClinic(clinicB);
    for (const id of colleagueUserIds) await deleteTestUser(id);
    await prisma.$disconnect();
  });

  const get = (path: string, token: string): Promise<Response> =>
    fetch(`${baseUrl}${path}`, { headers: { authorization: `Bearer ${token}` } });

  describe("a DOCTOR holds `own`", () => {
    it("reads their own schedule", async () => {
      const response = await get(`/doctors/${clinicA.doctorId}/schedule`, doctorToken);
      expect(response.status).toBe(200);
      expect(((await response.json()) as { doctorId: string }).doctorId).toBe(clinicA.doctorId);
    });

    /**
     * The heart of it. The guard allowed this request — the doctor genuinely holds the capability.
     * The scoping is in the query, and the answer is the same one a nonexistent id gets.
     */
    it("cannot read a colleague's schedule, and cannot tell it exists", async () => {
      const colleague = await get(`/doctors/${colleagueDoctorId}/schedule`, doctorToken);
      const nonexistent = await get(`/doctors/${NEVER_EXISTED}/schedule`, doctorToken);

      expect(colleague.status).toBe(404);
      expect(await colleague.text()).toBe(await nonexistent.text());
    });

    it("cannot write a colleague's templates", async () => {
      const response = await fetch(`${baseUrl}/doctors/${colleagueDoctorId}/schedule/templates`, {
        method: "PUT",
        headers: { authorization: `Bearer ${doctorToken}`, "content-type": "application/json" },
        body: JSON.stringify({
          templates: [
            { weekday: 2, startTime: "09:00", endTime: "17:00", validFrom: "2026-01-01", breaks: [] },
          ],
        }),
      });
      expect(response.status).toBe(404);

      // And nothing was written — the refusal is not merely a status code on a completed write.
      const stored = await withTenant(clinicA.tenantId, actorFor(clinicA.userId), (tx) =>
        tx.scheduleTemplate.findMany({ where: { doctorId: colleagueDoctorId } }),
      );
      expect(stored).toHaveLength(0);
    });

    /** Closing the clinic is an admin act; a doctor may only close their own diary. */
    /**
     * **403, not 404 — ruled 2026-09-07.** The one place in this controller where a refusal is
     * allowed to be a 403, and the reason it does not undermine the file's cross-tenant rule.
     *
     * Every other refusal here is about a *record*: a doctor id that belongs to a colleague or to
     * another clinic. Those must be indistinguishable from an id that never existed, because a 403
     * would confirm the row is real. This request names no record — `doctorId: null` is a
     * clinic-wide closure — and the refusal is decided from the caller's own role before anything
     * is read. It confirms only the caller's permission level, which they already hold.
     *
     * The 404 it used to return said "the thing you are creating does not exist", which is not a
     * sentence anybody could act on. The code carries the action instead: ask an admin.
     */
    it("cannot create a clinic-wide exception, and is told why rather than shown a 404", async () => {
      const response = await fetch(`${baseUrl}/doctors/${clinicA.doctorId}/schedule/exceptions`, {
        method: "POST",
        headers: { authorization: `Bearer ${doctorToken}`, "content-type": "application/json" },
        body: JSON.stringify({ doctorId: null, date: "2026-09-10", type: "HOLIDAY" }),
      });
      expect(response.status).toBe(403);
      expect(await response.clone().json()).toMatchObject({ code: "SCOPE_TOO_NARROW" });
    });

    /**
     * The half of the ruling that is easy to lose: widening one refusal to 403 must not widen the
     * neighbouring one. A doctor reaching for a *colleague's* diary still gets the same 404 as a
     * doctor id that never existed, byte for byte.
     */
    it("still cannot tell a colleague's diary from one that never existed", async () => {
      const colleague = await fetch(`${baseUrl}/doctors/${colleagueDoctorId}/schedule/exceptions`, {
        method: "POST",
        headers: { authorization: `Bearer ${doctorToken}`, "content-type": "application/json" },
        body: JSON.stringify({ doctorId: colleagueDoctorId, date: "2026-09-10", type: "HOLIDAY" }),
      });
      const nonexistent = await fetch(`${baseUrl}/doctors/${NEVER_EXISTED}/schedule/exceptions`, {
        method: "POST",
        headers: { authorization: `Bearer ${doctorToken}`, "content-type": "application/json" },
        body: JSON.stringify({ doctorId: NEVER_EXISTED, date: "2026-09-10", type: "HOLIDAY" }),
      });

      expect(colleague.status).toBe(404);
      expect(nonexistent.status).toBe(404);
      expect(await colleague.text()).toBe(await nonexistent.text());
    });
  });

  describe("an ADMIN holds `full`", () => {
    it("reads any doctor's schedule in their own clinic", async () => {
      const response = await get(`/doctors/${colleagueDoctorId}/schedule`, adminToken);
      expect(response.status).toBe(200);
    });

    it("still cannot reach another clinic's doctor", async () => {
      const foreign = await get(`/doctors/${clinicB.doctorId}/schedule`, adminToken);
      const nonexistent = await get(`/doctors/${NEVER_EXISTED}/schedule`, adminToken);

      expect(foreign.status).toBe(404);
      expect(await foreign.text()).toBe(await nonexistent.text());
    });
  });

  /**
   * Every §8 endpoint that takes an id, checked the same way. Enumerated rather than sampled: the
   * one that gets forgotten is the one nobody wrote a case for.
   */
  describe("cross-tenant ids are 404 on every endpoint that takes one", () => {
    it.each([
      ["GET /doctors/:id", (b: ClinicFixture) => `/doctors/${b.doctorId}`],
      ["GET /services/:id", (b: ClinicFixture) => `/services/${b.serviceId}`],
      ["GET /doctors/:id/schedule", (b: ClinicFixture) => `/doctors/${b.doctorId}/schedule`],
    ])("%s", async (_label, build) => {
      const foreign = await get(build(clinicB), adminToken);
      const nonexistent = await get(
        build({ ...clinicB, doctorId: NEVER_EXISTED, serviceId: NEVER_EXISTED }),
        adminToken,
      );

      expect(foreign.status).toBe(404);
      expect(await foreign.text()).toBe(await nonexistent.text());
    });

    /** A list endpoint must not leak either — it returns this clinic's rows and only those. */
    it("GET /doctors lists only this clinic's doctors", async () => {
      const response = await get("/doctors", adminToken);
      const ids = ((await response.json()) as { id: string }[]).map((d) => d.id);

      expect(ids).toContain(clinicA.doctorId);
      expect(ids).toContain(colleagueDoctorId);
      expect(ids).not.toContain(clinicB.doctorId);
    });

    it("GET /services lists only this clinic's services", async () => {
      const response = await get("/services", adminToken);
      const ids = ((await response.json()) as { id: string }[]).map((s) => s.id);

      expect(ids).toContain(clinicA.serviceId);
      expect(ids).not.toContain(clinicB.serviceId);
    });
  });
});
