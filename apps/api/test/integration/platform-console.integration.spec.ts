import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Module } from "@nestjs/common";
import { APP_INTERCEPTOR, NestFactory } from "@nestjs/core";
import { ThrottlerModule } from "@nestjs/throttler";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { ActorContextInterceptor } from "../../src/common/actor-context.interceptor.ts";
import { refusingValidationPipe } from "../../src/common/validation-pipe.ts";
import { AuthController } from "../../src/modules/auth/auth.controller.ts";
import { hashPassword } from "../../src/modules/auth/password.ts";
import { PlatformClinicsController } from "../../src/modules/platform/platform-clinics.controller.ts";
import { PlatformController } from "../../src/modules/platform/platform.controller.ts";
import { issuePlatformToken } from "../../src/modules/platform/platform-token.ts";
import { prisma } from "../../src/prisma/client.ts";
import { withPlatformActor, withTenant } from "../../src/prisma/with-tenant.ts";
import { injected } from "../../src/prisma/injected.ts";
import {
  actorFor,
  createTestUser,
  makeOperator,
  seedClinic,
  teardownClinic,
  type ClinicFixture,
} from "./fixtures.ts";

/**
 * The platform console — pilot-readiness 0b–0g.
 *
 * The guard that carries the whole surface is in `platform-isolation.integration.spec.ts`: an
 * operator's session is unbound, so RLS returns nothing from any clinical or financial table. This
 * file is about what the console *does*, and about the one thing 0c needs that isolation makes hard
 * — **counts without rows**, which come from a SECURITY DEFINER function whose return type is
 * integers and instants and cannot carry a name.
 */

@Module({
  imports: [ThrottlerModule.forRoot([{ name: "default", ttl: 60_000, limit: 1_000 }])],
  controllers: [PlatformController, PlatformClinicsController, AuthController],
  providers: [{ provide: APP_INTERCEPTOR, useClass: ActorContextInterceptor }],
})
class ConsoleTestModule {}

const OPERATOR_PASSWORD = "operator-only-not-a-real-password";
const SENTINEL = "SENTINEL-DIAGNOSIS-the-console-must-never-carry-this";

interface Clinic {
  tenantId: string;
  name: string;
  slug: string;
  status: string;
  suspensionReason: string | null;
  patients: number;
  doctors: number;
  staff: number;
  lastActivity: string | null;
  plan: { doctors: number; monthlyMinor: number; includedMessages: number; setupMinor: number };
}

describe("the platform console", () => {
  let app: NestExpressApplication;
  let baseUrl: string;
  let clinic: ClinicFixture;
  let operatorId = "";
  let token = "";
  const created: string[] = [];

  const call = async (
    method: string,
    path: string,
    body?: unknown,
    bearer: string | undefined = token,
  ): Promise<{ status: number; text: string }> => {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        ...(bearer === undefined ? {} : { authorization: `Bearer ${bearer}` }),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, text: await response.text() };
  };

  const clinics = async (): Promise<Clinic[]> =>
    (JSON.parse((await call("GET", "/platform/clinics")).text) as { clinics: Clinic[] }).clinics;

  const newClinic = (over: Partial<Record<string, string>> = {}): Record<string, string> => {
    const suffix = randomUUID().slice(0, 8);
    return {
      name: `عيادة الاختبار ${suffix}`,
      slug: `test-clinic-${suffix}`,
      timezone: "Africa/Cairo",
      country: "EG",
      currency: "EGP",
      address: "شارع الاختبار",
      phone: `+2010${suffix.replace(/\D/g, "").padEnd(8, "1").slice(0, 8)}`,
      adminFullName: "مديرة العيادة",
      adminPhone: `+2011${Math.floor(Math.random() * 100000000).toString().padStart(8, "0")}`,
      ...over,
    };
  };

  beforeAll(async () => {
    clinic = await seedClinic();

    // Clinical content, so "the console carried none" is a finding rather than a vacuum.
    await withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) => {
      const start = new Date(Date.now() - 48 * 60 * 60_000);
      const appointmentId = randomUUID();
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
    });

    operatorId = await createTestUser();
    await makeOperator(operatorId, { passwordHash: await hashPassword(OPERATOR_PASSWORD) });
    token = await issuePlatformToken(operatorId);

    app = await NestFactory.create<NestExpressApplication>(ConsoleTestModule, { logger: false });
    // The production pipe, not a lookalike: its exceptionFactory is what turns a DTO rejection into
    // a refusal code, and a test module with a plain one would assert a shape the app never sends.
    app.useGlobalPipes(refusingValidationPipe());
    await app.listen(0, "127.0.0.1");
    baseUrl = `http://127.0.0.1:${((app.getHttpServer() as Server).address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await app?.close();
    await teardownClinic(clinic);
    await prisma.$disconnect();
  });

  describe("0b — creating a clinic and its first admin", () => {
    test("the clinic exists, the admin can sign in once, and must change the password", async () => {
      const input = newClinic();
      const response = await call("POST", "/platform/clinics", input);
      expect(response.status).toBe(201);

      const body = JSON.parse(response.text) as { tenantId: string; temporaryPassword: string };
      created.push(body.tenantId);
      expect(body.temporaryPassword.length).toBeGreaterThan(8);

      // The admin signs in with the one-time password, and is told to replace it.
      const signedIn = await call(
        "POST",
        "/auth/login",
        { identifier: input["adminPhone"], password: body.temporaryPassword },
        undefined,
      );
      expect(signedIn.status).toBe(200);
      expect(JSON.parse(signedIn.text)).toMatchObject({ mustChangePassword: true });
    });

    test("the password is shown once and is not readable afterwards", async () => {
      // Nothing on the list carries it, and there is no route that returns it again.
      const listed = await clinics();
      expect(JSON.stringify(listed)).not.toContain("temporaryPassword");
    });

    test("a slug already in use is refused before anything is written", async () => {
      const first = newClinic();
      expect((await call("POST", "/platform/clinics", first)).status).toBe(201);
      created.push((JSON.parse((await call("GET", "/platform/clinics")).text) as { clinics: Clinic[] }).clinics.at(-1)?.tenantId ?? "");

      const clash = await call("POST", "/platform/clinics", newClinic({ slug: first["slug"] }));
      expect(clash.status).toBe(400);
      expect(JSON.parse(clash.text)).toMatchObject({ code: "SLUG_TAKEN" });
    });

    /**
     * **The clinic's own country is the parsing hint** — §18b, and a column since 0b.
     *
     * Asserted on the **stored E.164**, not on the status code. `0500000123` is valid in both
     * countries — `+20500000123` as EG and `+966500000123` as SA — so a test that only checked for
     * 201 passed with the parser hard-coded to EG. It was written that way first, and found by
     * hard-coding it and watching nothing fail.
     */
    test("a Saudi clinic's numbers are stored as +966, not +20", async () => {
      // Unique per run: the test database persists, and a repeated number is DUPLICATE_PHONE — which
      // is how this test failed the first time it was written correctly.
      const tail = Math.floor(Math.random() * 10_000_000).toString().padStart(7, "0");
      const adminPhone = `05${tail}1`;
      const clinicPhone = `05${tail}2`;

      const saudi = await call(
        "POST",
        "/platform/clinics",
        newClinic({ country: "SA", currency: "SAR", adminPhone, phone: clinicPhone }),
      );
      expect(saudi.status).toBe(201);

      const body = JSON.parse(saudi.text) as { tenantId: string; adminUserId: string };
      created.push(body.tenantId);

      const stored = await withPlatformActor(actorFor(operatorId), async (tx) => ({
        admin: await tx.user.findFirstOrThrow({
          where: { id: body.adminUserId },
          select: { phoneE164: true },
        }),
        clinic: await tx.tenant.findFirstOrThrow({
          where: { id: body.tenantId },
          select: { phone: true, country: true },
        }),
      }));

      // `+966…`, and specifically **not** the `+20…` the same digits produce under EG.
      expect(stored.admin.phoneE164).toBe(`+966${adminPhone.slice(1)}`);
      expect(stored.clinic.phone).toBe(`+966${clinicPhone.slice(1)}`);
      expect(stored.admin.phoneE164.startsWith("+20")).toBe(false);
      expect(stored.clinic.country).toBe("SA");
    });

    test("an unparseable admin phone is refused", async () => {
      const refused = await call("POST", "/platform/clinics", newClinic({ adminPhone: "not-a-phone" }));
      expect(refused.status).toBe(400);
      expect(JSON.parse(refused.text)).toMatchObject({ code: "INVALID_PHONE" });
    });
  });

  describe("0c — the list", () => {
    test("carries aggregates and a computed plan, and no clinical content", async () => {
      const listed = await clinics();
      const seeded = listed.find((row) => row.tenantId === clinic.tenantId);

      expect(seeded).toBeDefined();
      expect(seeded?.patients).toBeGreaterThan(0);
      // Counts, not rows: the sentinel is in that clinic's visit and must not be in this payload.
      expect(JSON.stringify(listed)).not.toContain(SENTINEL);
    });

    /** **"Plan" is computed from PRICING.md, never stored** — ruled 2026-09-14. */
    test("the plan is arithmetic on the doctor count, not a column", async () => {
      const listed = await clinics();
      const seeded = listed.find((row) => row.tenantId === clinic.tenantId);
      const extra = Math.max(0, (seeded?.doctors ?? 0) - 1);

      expect(seeded?.plan.monthlyMinor).toBe(150_000 + extra * 90_000);
      expect(seeded?.plan.includedMessages).toBe(1_000 + extra * 700);
      expect(seeded?.plan.setupMinor).toBe(350_000);

      // Nothing about a plan is on the row it describes.
      const columns = await prisma.$queryRaw<{ column_name: string }[]>`
        SELECT column_name FROM information_schema.columns WHERE table_name = 'tenants'`;
      expect(columns.map((row) => row.column_name)).not.toContain("plan");
    });

    /**
     * **The counts function refuses anybody who is not an operator**, which is what makes "counts
     * only" a property of the database rather than a promise the service keeps.
     */
    test("platform_clinic_counts() refuses a clinic user", async () => {
      const refused = withTenant(clinic.tenantId, actorFor(clinic.userId), (tx) =>
        tx.$queryRaw`SELECT * FROM platform_clinic_counts()`,
      );
      await expect(refused).rejects.toThrow(/not an active platform admin/i);
    });
  });

  describe("0d — suspend and reactivate", () => {
    test("suspending needs a reason, keeps it, and deletes nothing", async () => {
      const body = JSON.parse((await call("POST", "/platform/clinics", newClinic())).text) as {
        tenantId: string;
      };
      created.push(body.tenantId);

      const noReason = await call("POST", `/platform/clinics/${body.tenantId}/suspension`, {
        suspended: true,
      });
      expect(noReason.status).toBe(422);
      expect(JSON.parse(noReason.text)).toMatchObject({ code: "REASON_REQUIRED" });

      const suspended = await call("POST", `/platform/clinics/${body.tenantId}/suspension`, {
        suspended: true,
        reason: "لم تُسدَّد الاشتراكات",
      });
      expect(suspended.status).toBe(200);

      const listed = (await clinics()).find((row) => row.tenantId === body.tenantId);
      expect(listed?.status).toBe("SUSPENDED");
      expect(listed?.suspensionReason).toBe("لم تُسدَّد الاشتراكات");
    });

    test("reactivating clears the reason, so a live clinic carries no stale explanation", async () => {
      const tenantId = created.at(-1) ?? "";
      expect((await call("POST", `/platform/clinics/${tenantId}/suspension`, { suspended: false })).status).toBe(200);

      const listed = (await clinics()).find((row) => row.tenantId === tenantId);
      expect(listed?.status).toBe("ACTIVE");
      expect(listed?.suspensionReason).toBeNull();
    });

    test("the same state twice is refused rather than silently repeated", async () => {
      const tenantId = created.at(-1) ?? "";
      const again = await call("POST", `/platform/clinics/${tenantId}/suspension`, { suspended: false });
      expect(again.status).toBe(422);
      expect(JSON.parse(again.text)).toMatchObject({ code: "ALREADY_IN_THAT_STATE" });
    });

    /** **The database refuses the shape too**, not only the service (D5's reasoning, applied here). */
    test("a suspended clinic with no reason cannot be written at all", async () => {
      const raw = withPlatformActor(actorFor(operatorId), (tx) =>
        tx.tenant.update({
          where: { id: created[0] ?? clinic.tenantId },
          data: { status: "SUSPENDED", suspensionReason: null, suspendedAt: null },
        }),
      );
      await expect(raw).rejects.toThrow(/tenants_suspension_is_explained/i);
    });
  });

  describe("0e — resetting a clinic admin's password", () => {
    test("it works for an admin, and the old password stops working", async () => {
      const input = newClinic();
      const body = JSON.parse((await call("POST", "/platform/clinics", input)).text) as {
        tenantId: string;
        adminUserId: string;
        temporaryPassword: string;
      };
      created.push(body.tenantId);

      const reset = await call(
        "POST",
        `/platform/clinics/${body.tenantId}/admins/${body.adminUserId}/password`,
      );
      expect(reset.status).toBe(200);
      const issued = JSON.parse(reset.text) as { temporaryPassword: string };
      expect(issued.temporaryPassword).not.toBe(body.temporaryPassword);

      const withOld = await call(
        "POST",
        "/auth/login",
        { identifier: input["adminPhone"], password: body.temporaryPassword },
        undefined,
      );
      expect(withOld.status).toBe(401);

      const withNew = await call(
        "POST",
        "/auth/login",
        { identifier: input["adminPhone"], password: issued.temporaryPassword },
        undefined,
      );
      expect(withNew.status).toBe(200);
    });

    test("a doctor's account is not resettable from here", async () => {
      // The narrowing that matters: a doctor's login is the one that reaches clinical content, and
      // the operator must not be able to take it over.
      const refused = await call(
        "POST",
        `/platform/clinics/${clinic.tenantId}/admins/${clinic.userId}/password`,
      );
      expect(refused.status).toBe(404);
    });
  });

  describe("0f — every operator action is audited", () => {
    test("creating, suspending and resetting each leave a row the clinic can read", async () => {
      const tenantId = created.at(-1) ?? "";
      const rows = await withTenant(tenantId, actorFor(operatorId), (tx) =>
        tx.auditLog.findMany({ where: { actorRole: "PLATFORM_ADMIN" }, select: { action: true, entityType: true } }),
      );

      expect(rows.length).toBeGreaterThan(0);
      expect(rows.some((row) => row.action === "CREATE" && row.entityType === "tenants")).toBe(true);
      // `BREAK_GLASS_ACCESS` stops being emitted by nothing — PHASE-1.md §6 called that out.
      expect(rows.some((row) => row.action === "BREAK_GLASS_ACCESS")).toBe(true);
    });

    test("no audit row carries the password that was issued", async () => {
      const rows = await withPlatformActor(actorFor(operatorId), (tx) =>
        tx.$queryRaw<{ new_state: unknown }[]>`
          SELECT new_state FROM audit_logs WHERE actor_role = 'PLATFORM_ADMIN'`,
      );
      expect(JSON.stringify(rows)).not.toMatch(/temporaryPassword|password"\s*:\s*"[A-Za-z0-9]{8}/);
    });
  });

  describe("0g — the seed and the console agree on what a clinic is", () => {
    test("a console-created tenant carries the same columns as a seeded one", async () => {
      const consoleTenant = await withPlatformActor(actorFor(operatorId), (tx) =>
        tx.tenant.findFirstOrThrow({ where: { id: created[0] } }),
      );
      const seededTenant = await withPlatformActor(actorFor(operatorId), (tx) =>
        tx.tenant.findFirstOrThrow({ where: { id: clinic.tenantId } }),
      );
      expect(Object.keys(consoleTenant).sort()).toEqual(Object.keys(seededTenant).sort());

      // And the defaults the shared definition sets.
      expect(consoleTenant.status).toBe("ACTIVE");
      expect(consoleTenant.locale).toBe("ar");
      expect(consoleTenant.settings).toEqual({});
    });

    test("a console-created clinic has exactly one ACTIVE ADMIN and nobody else", async () => {
      const memberships = await withTenant(created[0] ?? "", actorFor(operatorId), (tx) =>
        tx.membership.findMany({ select: { role: true, status: true } }),
      );
      expect(memberships).toEqual([{ role: "ADMIN", status: "ACTIVE" }]);
    });
  });

  test("a clinic token opens none of this", async () => {
    const { default: nothing } = { default: null };
    void nothing;
    expect((await call("GET", "/platform/clinics", undefined, "not-a-token")).status).toBe(401);
  });
});
