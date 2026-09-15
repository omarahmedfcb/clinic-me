import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Module, ValidationPipe } from "@nestjs/common";
import { APP_INTERCEPTOR, NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { ActorContextInterceptor } from "../../src/common/actor-context.interceptor.ts";
import { issueAccessToken } from "../../src/modules/auth/jwt.ts";
import { AuditController } from "../../src/modules/audit/audit.controller.ts";
import { prisma } from "../../src/prisma/client.ts";
import { injected } from "../../src/prisma/injected.ts";
import { withTenant } from "../../src/prisma/with-tenant.ts";
import { actorFor, createTestUser, seedClinic, teardownClinic, type ClinicFixture } from "./fixtures.ts";

/**
 * The audit log viewer — Phase 5 PR 11.
 *
 * **Two guards, both named in the plan: the viewer cannot write, and cannot read another tenant's
 * rows.** A third is added here because the shape of `audit_logs` demands it — the table holds
 * `to_jsonb(NEW)` of every audited row, including every diagnosis in the product, and the roles
 * that hold `auditLog.read` hold `visits.readContent: NONE`. So the viewer must carry field
 * **names** and never values, and that is swept the way the leak guard sweeps: with a sentinel.
 */

@Module({
  controllers: [AuditController],
  providers: [{ provide: APP_INTERCEPTOR, useClass: ActorContextInterceptor }],
})
class AuditTestModule {}

const SENTINEL = "SENTINEL-DIAGNOSIS-audit-viewer-must-not-carry-this";

interface Page {
  entries: {
    id: string;
    actorUserId: string;
    actorName: string | null;
    action: string;
    entityType: string;
    entityId: string;
    changedFields: string[];
  }[];
  total: number;
}

describe("the audit log viewer", () => {
  let app: NestExpressApplication;
  let baseUrl: string;
  let clinic: ClinicFixture;
  let otherClinic: ClinicFixture;
  let adminToken = "";
  let receptionToken = "";
  let otherAdminToken = "";
  let renamedPatientId = "";

  const get = async (path: string, token: string): Promise<{ status: number; text: string }> => {
    const response = await fetch(`${baseUrl}${path}`, { headers: { authorization: `Bearer ${token}` } });
    return { status: response.status, text: await response.text() };
  };

  const adminTokenFor = async (fixture: ClinicFixture): Promise<string> => {
    const membershipId = randomUUID();
    await withTenant(fixture.tenantId, actorFor(fixture.userId), async (tx) => {
      await tx.membership.create({
        data: injected({ id: membershipId, userId: fixture.userId, role: "ADMIN", status: "ACTIVE" }),
      });
    });
    return issueAccessToken({
      sub: fixture.userId,
      membershipId,
      tenantId: fixture.tenantId,
      role: "ADMIN",
    });
  };

  beforeAll(async () => {
    clinic = await seedClinic();
    otherClinic = await seedClinic();

    // Something for the viewer to show: a visit carrying a clinical sentinel, and a patient
    // renamed — an UPDATE, so it has a previous state and therefore changed fields.
    await withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) => {
      const appointmentId = randomUUID();
      const start = new Date(Date.now() - 96 * 60 * 60_000);
      await tx.appointment.create({
        data: injected({
          id: appointmentId,
          patientId: clinic.patientId,
          doctorId: clinic.doctorId,
          serviceId: clinic.serviceId,
          scheduledStart: start,
          scheduledEnd: new Date(start.getTime() + 20 * 60_000),
          status: "COMPLETED",
          source: "RECEPTION",
          createdBy: clinic.userId,
          updatedBy: clinic.userId,
        }),
      });
      await tx.visit.create({
        data: injected({
          id: randomUUID(),
          patientId: clinic.patientId,
          doctorId: clinic.doctorId,
          appointmentId,
          diagnosis: SENTINEL,
          status: "COMPLETED",
          createdBy: clinic.userId,
        }),
      });
      await tx.patient.update({
        where: { id: clinic.patientId },
        data: { governorate: "القاهرة" },
      });
      renamedPatientId = clinic.patientId;
    });

    adminToken = await adminTokenFor(clinic);
    otherAdminToken = await adminTokenFor(otherClinic);

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

    app = await NestFactory.create<NestExpressApplication>(AuditTestModule, { logger: false });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.listen(0, "127.0.0.1");
    baseUrl = `http://127.0.0.1:${((app.getHttpServer() as Server).address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await app?.close();
    await teardownClinic(clinic);
    await teardownClinic(otherClinic);
    await prisma.$disconnect();
  });

  test("shows who did what, when, and to which record", async () => {
    const { status, text } = await get("/audit-log?limit=200", adminToken);
    expect(status).toBe(200);
    const page = JSON.parse(text) as Page;

    expect(page.total).toBeGreaterThan(0);
    const renamed = page.entries.find(
      (entry) => entry.entityType === "patients" && entry.action === "UPDATE",
    );
    expect(renamed?.entityId).toBe(renamedPatientId);
    // Field names, which is what an audit trail is for.
    expect(renamed?.changedFields).toContain("governorate");
    expect(renamed?.actorName?.length ?? 0).toBeGreaterThan(0);
  });

  /**
   * **The `users` audit, added in #100, must be visible here.**
   *
   * It was the point of auditing `users` at all: a role change or a suspension is the kind of act
   * somebody has to be able to look up afterwards, and a trail no screen reads is not one.
   */
  test("the users audit appears, and is offered as a filter", async () => {
    await withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) => {
      await tx.user.update({ where: { id: clinic.userId }, data: { fullName: "اسم بعد التعديل" } });
    });

    const filtered = JSON.parse(
      (await get("/audit-log?entityType=users&limit=50", adminToken)).text,
    ) as Page;
    expect(filtered.entries.length).toBeGreaterThan(0);
    expect(filtered.entries.every((entry) => entry.entityType === "users")).toBe(true);
    expect(filtered.entries.some((entry) => entry.changedFields.includes("full_name"))).toBe(true);

    const options = JSON.parse((await get("/audit-log/filters", adminToken)).text) as {
      actors: { userId: string }[];
      entityTypes: string[];
    };
    expect(options.entityTypes).toContain("users");
    expect(options.actors.some((actor) => actor.userId === clinic.userId)).toBe(true);
  });

  test("filtering by person and by day narrows the list", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const byPerson = JSON.parse(
      (await get(`/audit-log?actorUserId=${clinic.userId}&limit=200`, adminToken)).text,
    ) as Page;
    expect(byPerson.entries.every((entry) => entry.actorUserId === clinic.userId)).toBe(true);

    // A window that ends before anything happened returns nothing rather than everything — the
    // failure a filter built with the wrong comparison produces.
    const longAgo = JSON.parse(
      (await get(`/audit-log?from=2020-01-01&to=2020-01-02&limit=50`, adminToken)).text,
    ) as Page;
    expect(longAgo.entries).toEqual([]);

    // And today is inclusive of the whole day, not cut off at its first instant.
    const includingToday = JSON.parse(
      (await get(`/audit-log?from=${today}&to=${today}&limit=200`, adminToken)).text,
    ) as Page;
    expect(includingToday.entries.length).toBeGreaterThan(0);
  });

  /** **Guard: the viewer cannot read another tenant's rows** — nothing, never a 403. */
  test("a second tenant's admin sees none of this clinic's rows, and does see their own", async () => {
    const { status, text } = await get(`/audit-log?actorUserId=${clinic.userId}&limit=200`, otherAdminToken);
    expect(status).toBe(200);
    expect((JSON.parse(text) as Page).entries).toEqual([]);

    // Not vacuous: the same token reading its own clinic gets rows, so the empty answer above is
    // isolation rather than a viewer that returns nothing to anybody.
    const own = JSON.parse((await get("/audit-log?limit=200", otherAdminToken)).text) as Page;
    expect(own.entries.length).toBeGreaterThan(0);
    expect(own.entries.every((entry) => entry.actorUserId !== clinic.userId)).toBe(true);
  });

  /**
   * **Guard: the viewer cannot write.**
   *
   * Two halves, because either alone is weak. There is no write route on the controller — asserted
   * by the router rather than by reading the file — and the table refuses a write through the same
   * path the viewer reads on, which is the append-only trigger doing its job under it.
   */
  test("there is no write route, and the table refuses one anyway", async () => {
    for (const method of ["POST", "PATCH", "PUT", "DELETE"]) {
      const response = await fetch(`${baseUrl}/audit-log`, {
        method,
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect({ method, status: response.status }).toEqual({ method, status: 404 });
    }

    const row = await withTenant(clinic.tenantId, actorFor(clinic.userId), (tx) =>
      tx.auditLog.findFirstOrThrow({ select: { id: true } }),
    );
    const edit = withTenant(clinic.tenantId, actorFor(clinic.userId), (tx) =>
      tx.auditLog.update({ where: { id: row.id }, data: { actorRole: "OWNER" } }),
    );
    await expect(edit).rejects.toThrow(/append-only/i);
  });

  /**
   * **The §8 boundary, swept the way the leak guard sweeps.**
   *
   * `audit_logs` holds `to_jsonb(NEW)` of every audited row, so the diagnosis written above is
   * physically in this table. An admin holds `auditLog.read` and `visits.readContent: NONE`, so
   * the viewer must carry the field name and never the value.
   */
  test("an admin reading the log never receives clinical content", async () => {
    const { text } = await get("/audit-log?limit=200", adminToken);
    expect(text).not.toContain(SENTINEL);
    // Not vacuous: the visit row is in the log, and the viewer says so.
    expect(text).toContain("visits");
  });

  test("reception is refused at the guard", async () => {
    expect((await get("/audit-log", receptionToken)).status).toBe(403);
    expect((await get("/audit-log/filters", receptionToken)).status).toBe(403);
  });
});
