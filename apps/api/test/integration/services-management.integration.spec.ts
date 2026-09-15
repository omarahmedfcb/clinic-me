import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Module, ValidationPipe } from "@nestjs/common";
import { APP_INTERCEPTOR, NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { ActorContextInterceptor } from "../../src/common/actor-context.interceptor.ts";
import { issueAccessToken } from "../../src/modules/auth/jwt.ts";
import { ServicesController } from "../../src/modules/services/services.controller.ts";
import { listServices } from "../../src/modules/services/services.service.ts";
import { prisma } from "../../src/prisma/client.ts";
import { injected } from "../../src/prisma/injected.ts";
import { withTenant } from "../../src/prisma/with-tenant.ts";
import { actorFor, seedClinic, teardownClinic, type ClinicFixture } from "./fixtures.ts";

/**
 * Clinic-managed services — `PHASE-4.md` §6, `PHASE-5-DESIGN.md` §2.
 *
 * The services backend existed before this file and had **no tests at all**, which is why this
 * covers the whole surface rather than only what changed. Two things here are rulings rather than
 * general hygiene:
 *
 * **Pricing is owner and admin only** (§2.1). A doctor's pricing power is confined to the Phase 5
 * ad-hoc line, where it is flagged and reviewable; reception has none. That is asserted at the
 * guard against a real token, because a screen that hides a button is not access control.
 *
 * **Deactivation does nothing to appointments already booked** (§2.3, ruled 2026-09-03). The screen
 * warns "N future appointments use this service" and proceeds. So the count has to be honest — it
 * excludes cancelled and completed ones, because a warning that counts three cancellations as three
 * upcoming visits makes an admin hesitate over nothing — and the appointments themselves have to be
 * provably untouched afterwards.
 */
@Module({
  controllers: [ServicesController],
  providers: [{ provide: APP_INTERCEPTOR, useClass: ActorContextInterceptor }],
})
class ServicesTestModule {}

describe("clinic-managed services", () => {
  let app: NestExpressApplication;
  let baseUrl: string;
  let clinicA: ClinicFixture;
  let clinicB: ClinicFixture;

  let ownerToken: string;
  let adminToken: string;
  let doctorToken: string;
  let receptionToken: string;

  const NEVER_EXISTED = "00000000-0000-7000-8000-00000000dead";

  /** Fixed instants, so "future" is a decision this test makes rather than one the clock makes. */
  const NOW = new Date("2026-10-01T09:00:00Z");
  const LATER = new Date("2026-10-01T12:00:00Z");
  const EARLIER = new Date("2026-10-01T06:00:00Z");

  beforeAll(async () => {
    clinicA = await seedClinic();
    clinicB = await seedClinic();

    app = await NestFactory.create<NestExpressApplication>(ServicesTestModule, { logger: false });
    app.set("trust proxy", 1);
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();
    await app.listen(0, "127.0.0.1");
    baseUrl = `http://127.0.0.1:${((app.getHttpServer() as Server).address() as AddressInfo).port}`;

    const tokenFor = (role: "OWNER" | "ADMIN" | "DOCTOR" | "RECEPTIONIST"): Promise<string> =>
      issueAccessToken({
        sub: clinicA.userId,
        membershipId: randomUUID(),
        tenantId: clinicA.tenantId,
        role,
      });

    [ownerToken, adminToken, doctorToken, receptionToken] = await Promise.all([
      tokenFor("OWNER"),
      tokenFor("ADMIN"),
      tokenFor("DOCTOR"),
      tokenFor("RECEPTIONIST"),
    ]);
  });

  afterAll(async () => {
    await app?.close();
    await teardownClinic(clinicA);
    await teardownClinic(clinicB);
    await prisma.$disconnect();
  });

  const request = (method: string, path: string, token: string, body?: unknown): Promise<Response> =>
    fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  const newService = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    nameAr: "استشارة",
    nameEn: "Consultation",
    type: "CONSULTATION",
    durationMinutes: 20,
    bufferMinutes: 0,
    priceMinor: 20000,
    ...overrides,
  });

  async function createService(overrides: Record<string, unknown> = {}): Promise<string> {
    const response = await request("POST", "/services", ownerToken, newService(overrides));
    expect(response.status).toBe(201);
    return ((await response.json()) as { id: string }).id;
  }

  /** Non-overlapping starts, so `no_double_booking` is never the reason a row fails to appear. */
  async function bookOnto(
    serviceId: string,
    status: "BOOKED" | "CANCELLED" | "COMPLETED",
    start: Date,
  ): Promise<void> {
    await withTenant(clinicA.tenantId, actorFor(clinicA.userId), async (tx) => {
      await tx.appointment.create({
        data: injected({
          patientId: clinicA.patientId,
          doctorId: clinicA.doctorId,
          serviceId,
          scheduledStart: start,
          scheduledEnd: new Date(start.getTime() + 20 * 60_000),
          status,
          source: "RECEPTION",
          createdBy: clinicA.userId,
          updatedBy: clinicA.userId,
        }),
      });
    });
  }

  describe("who may create and price a service", () => {
    it("lets an owner create one", async () => {
      const response = await request("POST", "/services", ownerToken, newService());
      expect(response.status).toBe(201);
      const created = (await response.json()) as {
        priceMinor: number;
        futureAppointmentCount: number;
      };
      expect(created.priceMinor).toBe(20000);
      // Nothing can be booked onto a service that did not exist a moment ago.
      expect(created.futureAppointmentCount).toBe(0);
    });

    it("lets an admin create one", async () => {
      const response = await request(
        "POST",
        "/services",
        adminToken,
        newService({ nameEn: "Admin made" }),
      );
      expect(response.status).toBe(201);
    });

    it("refuses a doctor, at the guard", async () => {
      const response = await request(
        "POST",
        "/services",
        doctorToken,
        newService({ nameEn: "Doctor made" }),
      );
      expect(response.status).toBe(403);
    });

    it("refuses reception, at the guard", async () => {
      const response = await request(
        "POST",
        "/services",
        receptionToken,
        newService({ nameEn: "Desk made" }),
      );
      expect(response.status).toBe(403);
    });

    it("refuses a doctor and reception on update too, not only on create", async () => {
      const id = await createService({ nameEn: "For update" });

      for (const token of [doctorToken, receptionToken]) {
        const response = await request("PATCH", `/services/${id}`, token, { priceMinor: 1 });
        expect(response.status).toBe(403);
      }
    });

    it("still lets reception read the list, because booking needs it", async () => {
      const response = await request("GET", "/services", receptionToken);
      expect(response.status).toBe(200);
    });
  });

  describe("the DTO refuses what the database constraints also refuse", () => {
    it("rejects a negative price with 400", async () => {
      const response = await request("POST", "/services", ownerToken, newService({ priceMinor: -1 }));
      expect(response.status).toBe(400);
    });

    it("rejects a zero-length appointment with 400", async () => {
      const response = await request(
        "POST",
        "/services",
        ownerToken,
        newService({ durationMinutes: 0 }),
      );
      expect(response.status).toBe(400);
    });

    it("rejects an unknown field rather than silently ignoring it", async () => {
      const response = await request(
        "POST",
        "/services",
        ownerToken,
        newService({ tenantId: clinicB.tenantId }),
      );
      expect(response.status).toBe(400);
    });
  });

  describe("another clinic's service is indistinguishable from one that never existed", () => {
    it("answers 404 identically for both, and never 403", async () => {
      const foreign = await request("GET", `/services/${clinicB.serviceId}`, ownerToken);
      const fictional = await request("GET", `/services/${NEVER_EXISTED}`, ownerToken);

      expect(foreign.status).toBe(404);
      expect(fictional.status).toBe(404);
      expect(await foreign.text()).toBe(await fictional.text());
    });

    it("answers 404 on update of another clinic's service", async () => {
      const response = await request("PATCH", `/services/${clinicB.serviceId}`, ownerToken, {
        priceMinor: 1,
      });
      expect(response.status).toBe(404);
    });
  });

  describe("the deactivation warning counts what is actually going to happen", () => {
    const countFor = async (serviceId: string): Promise<number> => {
      const response = await request("GET", `/services/${serviceId}`, ownerToken);
      return ((await response.json()) as { futureAppointmentCount: number }).futureAppointmentCount;
    };

    it("counts a future booking, and ignores cancelled, completed and past ones", async () => {
      const id = await createService({ nameEn: "Counted" });

      expect(await countFor(id)).toBe(0);

      await bookOnto(id, "BOOKED", new Date("2027-03-01T09:00:00Z"));
      expect(await countFor(id)).toBe(1);

      // None of these three is an upcoming visit, and counting any of them would make the warning
      // overstate what deactivation is about to affect.
      await bookOnto(id, "CANCELLED", new Date("2027-03-01T10:00:00Z"));
      await bookOnto(id, "COMPLETED", new Date("2027-03-01T11:00:00Z"));
      await bookOnto(id, "BOOKED", new Date("2020-01-01T09:00:00Z"));

      expect(await countFor(id)).toBe(1);
    });

    it("deactivating leaves every one of those appointments exactly where it was", async () => {
      const id = await createService({ nameEn: "Deactivated" });
      const start = new Date("2027-04-01T09:00:00Z");
      await bookOnto(id, "BOOKED", start);

      const before = await withTenant(clinicA.tenantId, actorFor(clinicA.userId), (tx) =>
        tx.appointment.findMany({ where: { serviceId: id }, orderBy: { scheduledStart: "asc" } }),
      );

      const response = await request("PATCH", `/services/${id}`, ownerToken, { isActive: false });
      expect(response.status).toBe(200);
      const updated = (await response.json()) as {
        isActive: boolean;
        futureAppointmentCount: number;
      };

      // The ruling: deactivation removes the service from the booking dropdown and does nothing
      // else. The response still reports the count, because those appointments are still coming.
      expect(updated.isActive).toBe(false);
      expect(updated.futureAppointmentCount).toBe(1);

      const after = await withTenant(clinicA.tenantId, actorFor(clinicA.userId), (tx) =>
        tx.appointment.findMany({ where: { serviceId: id }, orderBy: { scheduledStart: "asc" } }),
      );
      expect(after).toEqual(before);
      expect(after[0]?.status).toBe("BOOKED");
      expect(after[0]?.scheduledStart).toEqual(start);
    });
  });

  describe("the instant is a parameter, not the clock", () => {
    it("moves an appointment across the boundary by moving only the instant", async () => {
      const id = await createService({ nameEn: "Boundary" });
      await bookOnto(id, "BOOKED", NOW);

      const caller = { tenantId: clinicA.tenantId, actor: actorFor(clinicA.userId) };
      const at = async (instant: Date): Promise<number> =>
        (await listServices(caller, instant)).find((service) => service.id === id)
          ?.futureAppointmentCount ?? -1;

      // Same row, same query, two instants. Nothing here waits for a clock to reach a boundary.
      expect(await at(EARLIER)).toBe(1);
      expect(await at(LATER)).toBe(0);
    });
  });
});
