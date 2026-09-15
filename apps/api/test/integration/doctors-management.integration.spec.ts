import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Module, ValidationPipe } from "@nestjs/common";
import { APP_INTERCEPTOR, NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { ActorContextInterceptor } from "../../src/common/actor-context.interceptor.ts";
import { issueAccessToken } from "../../src/modules/auth/jwt.ts";
import { DoctorsController } from "../../src/modules/doctors/doctors.controller.ts";
import { MembershipsController } from "../../src/modules/memberships/memberships.controller.ts";
import { prisma } from "../../src/prisma/client.ts";
import { injected } from "../../src/prisma/injected.ts";
import { withTenant } from "../../src/prisma/with-tenant.ts";
import { actorFor, createTestUser, seedClinic, teardownClinic, type ClinicFixture } from "./fixtures.ts";

/**
 * The doctors admin screen's backend — the deactivation warning, and who may act.
 *
 * The doctors module existed before this file with `listDoctors`, `createDoctor` and
 * `updateDoctor`, and **no test covering the count the screen now shows**, because there was no
 * count. `futureAppointmentCount` is added here for the same reason services has one, and the
 * argument is stronger: a deactivated service that still has bookings gets performed anyway, while
 * a deactivated doctor has appointments nobody is going to see.
 *
 * So the count has to be honest in the same two ways services' is — it excludes appointments that
 * are not going to happen, and it excludes ones already past — and deactivation has to leave the
 * appointments themselves untouched, because the warning informs and never blocks.
 */
@Module({
  controllers: [DoctorsController, MembershipsController],
  providers: [{ provide: APP_INTERCEPTOR, useClass: ActorContextInterceptor }],
})
class DoctorsTestModule {}

interface DoctorRow {
  id: string;
  fullName: string;
  isActive: boolean;
  futureAppointmentCount: number;
  licenseExpiry: string | null;
  roomNumber: string | null;
}

interface MembershipRow {
  membershipId: string;
  fullName: string;
  role: string;
  status: string;
  hasDoctorRecord: boolean;
}

describe("doctors management", () => {
  let app: NestExpressApplication;
  let baseUrl: string;
  let clinic: ClinicFixture;
  let otherClinic: ClinicFixture;

  let adminToken: string;
  let receptionToken: string;
  let otherTenantAdminToken: string;

  const request = async (
    path: string,
    token: string,
    init?: RequestInit,
  ): Promise<{ status: number; body: unknown }> => {
    const response = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        ...(init?.body === undefined ? {} : { "content-type": "application/json" }),
        ...init?.headers,
      },
    });
    const text = await response.text();
    return { status: response.status, body: text === "" ? null : JSON.parse(text) };
  };

  const listAs = async (token: string): Promise<DoctorRow[]> =>
    (await request("/doctors", token)).body as DoctorRow[];

  const membershipWithRole = async (role: "ADMIN" | "RECEPTIONIST"): Promise<string> => {
    const userId = await createTestUser();
    let membershipId = "";
    await withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) => {
      membershipId = randomUUID();
      await tx.membership.create({ data: injected({ id: membershipId, userId, role, status: "ACTIVE" }) });
    });
    return issueAccessToken({ sub: userId, membershipId, tenantId: clinic.tenantId, role });
  };

  /** An appointment for the fixture doctor at a chosen offset and status. */
  const appointment = async (input: {
    minutesFromNow: number;
    status: "BOOKED" | "CANCELLED" | "COMPLETED";
  }): Promise<string> => {
    const id = randomUUID();
    await withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) => {
      const start = new Date(Date.now() + input.minutesFromNow * 60_000);
      await tx.appointment.create({
        data: injected({
          id,
          patientId: clinic.patientId,
          doctorId: clinic.doctorId,
          serviceId: clinic.serviceId,
          scheduledStart: start,
          scheduledEnd: new Date(start.getTime() + 20 * 60_000),
          status: input.status,
          source: "RECEPTION",
          // There is no `cancelled_at` column -- the reason is the record. Checked against the
          // schema rather than assumed, after Prisma refused the invented field.
          ...(input.status === "CANCELLED" ? { cancellationReason: "test fixture" } : {}),
          createdBy: clinic.userId,
          updatedBy: clinic.userId,
        }),
      });
    });
    return id;
  };

  beforeAll(async () => {
    clinic = await seedClinic();
    otherClinic = await seedClinic();

    adminToken = await membershipWithRole("ADMIN");
    receptionToken = await membershipWithRole("RECEPTIONIST");
    otherTenantAdminToken = await issueAccessToken({
      sub: otherClinic.userId,
      membershipId: otherClinic.membershipId,
      tenantId: otherClinic.tenantId,
      role: "OWNER",
    });

    app = await NestFactory.create<NestExpressApplication>(DoctorsTestModule, { logger: false });
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        transformOptions: { enableImplicitConversion: true },
      }),
    );
    await app.init();
    await app.listen(0, "127.0.0.1");
    baseUrl = `http://127.0.0.1:${((app.getHttpServer() as Server).address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    if (app !== undefined) await app.close();
    await teardownClinic(clinic);
    await teardownClinic(otherClinic);
    await prisma.$disconnect();
  });

  describe("the list", () => {
    test("includes inactive doctors, because the screen has to be able to reactivate one", async () => {
      const before = await listAs(adminToken);
      expect(before.length).toBeGreaterThan(0);

      await request(`/doctors/${clinic.doctorId}`, adminToken, {
        method: "PATCH",
        body: JSON.stringify({ isActive: false }),
      });

      const after = await listAs(adminToken);
      expect(after.map((d) => d.id)).toContain(clinic.doctorId);
      expect(after.find((d) => d.id === clinic.doctorId)?.isActive).toBe(false);

      // Put it back, so the count tests below start from a known state.
      await request(`/doctors/${clinic.doctorId}`, adminToken, {
        method: "PATCH",
        body: JSON.stringify({ isActive: true }),
      });
    });

    test("another tenant's doctors are not in it", async () => {
      const mine = await listAs(adminToken);
      const theirs = await listAs(otherTenantAdminToken);

      expect(mine.map((d) => d.id)).not.toContain(otherClinic.doctorId);
      expect(theirs.map((d) => d.id)).not.toContain(clinic.doctorId);
      // Unequal fixtures would be better still, but both clinics seed one doctor; the id check is
      // what actually proves the partition rather than the length.
      expect(theirs.map((d) => d.id)).toContain(otherClinic.doctorId);
    });
  });

  describe("the deactivation warning counts only what is going to happen", () => {
    const countFor = async (): Promise<number> =>
      (await listAs(adminToken)).find((d) => d.id === clinic.doctorId)?.futureAppointmentCount ?? -1;

    test("a booked future appointment is counted", async () => {
      const before = await countFor();
      await appointment({ minutesFromNow: 60, status: "BOOKED" });
      expect(await countFor()).toBe(before + 1);
    });

    test("a cancelled future appointment is not", async () => {
      // A warning that counts three cancellations as three upcoming visits makes an admin hesitate
      // over nothing.
      const before = await countFor();
      await appointment({ minutesFromNow: 120, status: "CANCELLED" });
      expect(await countFor()).toBe(before);
    });

    test("a past appointment is not, whatever its status", async () => {
      const before = await countFor();
      await appointment({ minutesFromNow: -600, status: "BOOKED" });
      await appointment({ minutesFromNow: -700, status: "COMPLETED" });
      expect(await countFor()).toBe(before);
    });
  });

  describe("deactivation", () => {
    test("warns and proceeds — the appointments are untouched afterwards", async () => {
      const appointmentId = await appointment({ minutesFromNow: 240, status: "BOOKED" });

      const before = await countFor();
      expect(before).toBeGreaterThan(0);

      const result = await request(`/doctors/${clinic.doctorId}`, adminToken, {
        method: "PATCH",
        body: JSON.stringify({ isActive: false }),
      });
      expect(result.status).toBe(200);
      expect((result.body as DoctorRow).isActive).toBe(false);

      // The whole point of "a warning, not a gate": the appointment stands.
      const still = await withTenant(clinic.tenantId, actorFor(clinic.userId), (tx) =>
        tx.appointment.findFirst({ where: { id: appointmentId }, select: { status: true } }),
      );
      expect(still?.status).toBe("BOOKED");

      // And the count returned by the write is measured after it, so the screen is told what is
      // still standing rather than what was standing a moment ago.
      expect((result.body as DoctorRow).futureAppointmentCount).toBe(before);

      await request(`/doctors/${clinic.doctorId}`, adminToken, {
        method: "PATCH",
        body: JSON.stringify({ isActive: true }),
      });
    });

    async function countFor(): Promise<number> {
      return (
        (await listAs(adminToken)).find((d) => d.id === clinic.doctorId)?.futureAppointmentCount ?? -1
      );
    }
  });

  /**
   * Room number and licence expiry — ruled 2026-09-05, narrowed from "personal and professional
   * data" to the two fields with an operational consequence.
   */
  describe("room number and licence expiry", () => {
    const patch = (body: unknown) =>
      request(`/doctors/${clinic.doctorId}`, adminToken, {
        method: "PATCH",
        body: JSON.stringify(body),
      });

    const current = async (): Promise<DoctorRow> =>
      (await listAs(adminToken)).find((d) => d.id === clinic.doctorId) as DoctorRow;

    it("are null on a doctor nobody has filled them in for", async () => {
      const row = await current();
      expect(row.licenseExpiry).toBeNull();
      expect(row.roomNumber).toBeNull();
    });

    it("round-trip as a calendar day and free text", async () => {
      const result = await patch({ licenseExpiry: "2027-06-30", roomNumber: "2أ" });
      expect(result.status).toBe(200);

      const row = await current();
      // A calendar day, not an instant: sending a timestamp would invite a client to render it in
      // its own timezone and shift it a day.
      expect(row.licenseExpiry).toBe("2027-06-30");
      // Free text, and Arabic: a numeric column would refuse this room.
      expect(row.roomNumber).toBe("2أ");
    });

    it("accepts an expiry in the past, which is the case worth surfacing", async () => {
      // A constraint refusing past dates would make an expired licence the one thing that cannot
      // be recorded -- and an expired licence is precisely what a clinic needs to know about.
      expect((await patch({ licenseExpiry: "2020-01-01" })).status).toBe(200);
      expect((await current()).licenseExpiry).toBe("2020-01-01");
    });

    it("clears with null, which is not the same as omitting the field", async () => {
      await patch({ licenseExpiry: "2027-06-30", roomNumber: "3" });

      // Omitting leaves it alone.
      await patch({ specialty: "General" });
      expect((await current()).roomNumber).toBe("3");

      // Null clears it, so an admin can undo a typo.
      expect((await patch({ roomNumber: null })).status).toBe(200);
      expect((await current()).roomNumber).toBeNull();
    });

    it("refuses a licence expiry that is not a date", async () => {
      expect((await patch({ licenseExpiry: "soon" })).status).toBe(400);
    });
  });

  /**
   * `GET /memberships` — the listing half of item 2. It exists so the doctors screen can offer a
   * picker; it deliberately cannot create anyone, because nothing in this API can.
   */
  describe("the memberships listing", () => {
    const memberships = async (token: string): Promise<MembershipRow[]> =>
      (await request("/memberships", token)).body as MembershipRow[];

    it("lists this clinic's staff to an admin", async () => {
      const rows = await memberships(adminToken);
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(typeof row.fullName).toBe("string");
        expect(typeof row.hasDoctorRecord).toBe("boolean");
      }
    });

    it("flags the membership that is already a doctor, so a picker need not guess", async () => {
      const rows = await memberships(adminToken);
      const doctorMembership = rows.find((r) => r.membershipId === clinic.membershipId);
      expect(doctorMembership?.hasDoctorRecord).toBe(true);

      // And at least one that is not -- otherwise the flag proves nothing.
      expect(rows.some((r) => !r.hasDoctorRecord)).toBe(true);
    });

    it("is refused to reception at the guard", async () => {
      // A staff directory with emails and phone numbers is not booking information.
      const response = await request("/memberships", receptionToken);
      expect(response.status).toBe(403);
      expect(JSON.stringify(response.body)).not.toContain("@");
    });

    it("does not leak another tenant's staff", async () => {
      const mine = await memberships(adminToken);
      const theirs = await memberships(otherTenantAdminToken);
      const myIds = new Set(mine.map((r) => r.membershipId));
      for (const row of theirs) expect(myIds.has(row.membershipId)).toBe(false);
    });

    it("has no create route — nothing in this API can make a user", async () => {
      const response = await request("/memberships", adminToken, {
        method: "POST",
        body: JSON.stringify({ userId: randomUUID(), role: "RECEPTIONIST" }),
      });
      // 404 from the router, not 403 from a guard: the route does not exist, which is the honest
      // answer while user creation is deferred.
      expect(response.status).toBe(404);
    });
  });

  describe("who may act", () => {
    test("reception can read the list — it is booking information", async () => {
      // `appointments.write` guards the read: reception picks a doctor when booking.
      expect((await request("/doctors", receptionToken)).status).toBe(200);
    });

    test("reception cannot deactivate a doctor", async () => {
      const response = await request(`/doctors/${clinic.doctorId}`, receptionToken, {
        method: "PATCH",
        body: JSON.stringify({ isActive: false }),
      });
      // `users.manage` is OWNER and ADMIN only. Refused at the guard, before the handler runs.
      expect(response.status).toBe(403);
    });

    test("another tenant's doctor is 404, not 403", async () => {
      const response = await request(`/doctors/${clinic.doctorId}`, otherTenantAdminToken, {
        method: "PATCH",
        body: JSON.stringify({ isActive: false }),
      });
      expect(response.status).toBe(404);
    });
  });
});
