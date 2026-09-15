import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Module, ValidationPipe } from "@nestjs/common";
import { APP_INTERCEPTOR, NestFactory } from "@nestjs/core";
import { ThrottlerModule } from "@nestjs/throttler";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { ActorContextInterceptor } from "../../src/common/actor-context.interceptor.ts";
import { issueAccessToken } from "../../src/modules/auth/jwt.ts";
import { hashPassword } from "../../src/modules/auth/password.ts";
import { AuthController } from "../../src/modules/auth/auth.controller.ts";
import { PatientsController } from "../../src/modules/patients/patients.controller.ts";
import { PlatformController } from "../../src/modules/platform/platform.controller.ts";
import { issuePlatformToken } from "../../src/modules/platform/platform-token.ts";
import { prisma } from "../../src/prisma/client.ts";
import { injected } from "../../src/prisma/injected.ts";
import { withPlatformActor, withTenant } from "../../src/prisma/with-tenant.ts";
import { actorFor, createTestUser, seedClinic, teardownClinic, type ClinicFixture } from "./fixtures.ts";

/**
 * The platform console's wall — pilot-readiness 0a.
 *
 * **The guard: RLS blocks the operator from clinical and financial rows, and the sweep proves it.**
 * Not "the controller does not select them" — a controller can be rewritten. The operator's session
 * binds no `app.current_tenant_id`, so every policy's `tenant_id = NULLIF(current_setting(...), '')`
 * is false and the rows are not there to be selected. That is a property of having no tenant, and
 * the test below drives it from an operator's own session rather than asserting it about the design.
 *
 * The second half is the sweep: **every** `/platform/*` route, checked for clinical sentinels. A
 * route nobody lists is a route nobody sweeps, which is the lesson `clinical-leak-guard` was written
 * from — so the list here is the point of the file, and 0b onwards add to it.
 */

@Module({
  imports: [ThrottlerModule.forRoot([{ name: "default", ttl: 60_000, limit: 1_000 }])],
  controllers: [PlatformController, PatientsController, AuthController],
  providers: [{ provide: APP_INTERCEPTOR, useClass: ActorContextInterceptor }],
})
class PlatformTestModule {}

const OPERATOR_PASSWORD = "operator-only-not-a-real-password";
const SENTINEL = "SENTINEL-DIAGNOSIS-the-operator-must-never-see-this";

/** Every `/platform/*` route. **Add one here when you add one to the product.** */
const PLATFORM_ROUTES: { name: string; path: string }[] = [{ name: "who the operator is", path: "/platform/me" }];

/** The tables an operator must be unable to read a single row of. */
const FORBIDDEN_TABLES = [
  "patients",
  "visits",
  "payments",
  "visit_charges",
  "patient_credits",
  "appointments",
] as const;

describe("the platform console reads no clinic data", () => {
  let app: NestExpressApplication;
  let baseUrl: string;
  let clinic: ClinicFixture;
  let operatorId = "";
  let operatorToken = "";
  let clinicToken = "";
  /** A real, ACTIVE account with the SAME password and no flag. The flag must be the only refusal. */
  let unflaggedId = "";
  let unflaggedPhone = "";

  const call = async (
    method: string,
    path: string,
    token?: string,
    body?: unknown,
  ): Promise<{ status: number; text: string }> => {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, text: await response.text() };
  };

  beforeAll(async () => {
    clinic = await seedClinic();

    // Real clinical content, so "the operator saw nothing" is a finding rather than a vacuum.
    await withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) => {
      const start = new Date(Date.now() - 72 * 60 * 60_000);
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

    // The operator: a global user with the flag and **no membership anywhere**.
    operatorId = await createTestUser();
    // Through `withPlatformActor`: `users_audit` refuses an UPDATE with no actor bound (D16), and
    // the operator has no tenant to bind one through. That helper is the operator's session shape.
    const hashed = await hashPassword(OPERATOR_PASSWORD);
    await withPlatformActor(actorFor(operatorId), (tx) =>
      tx.user.update({
        where: { id: operatorId },
        data: { isPlatformAdmin: true, status: "ACTIVE", passwordHash: hashed },
      }),
    );

    // The control for the flag check: a real clinic account, ACTIVE, with an active membership and
    // the *same* password as the operator. The only difference is `is_platform_admin`.
    unflaggedId = clinic.userId;
    unflaggedPhone = (
      await withPlatformActor(actorFor(operatorId), (tx) =>
        tx.user.update({
          where: { id: unflaggedId },
          data: { passwordHash: hashed },
          select: { phoneE164: true },
        }),
      )
    ).phoneE164;

    clinicToken = await issueAccessToken({
      sub: clinic.userId,
      membershipId: clinic.membershipId,
      tenantId: clinic.tenantId,
      role: "DOCTOR",
    });

    app = await NestFactory.create<NestExpressApplication>(PlatformTestModule, { logger: false });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.listen(0, "127.0.0.1");
    baseUrl = `http://127.0.0.1:${((app.getHttpServer() as Server).address() as AddressInfo).port}`;

    operatorToken = await issuePlatformToken(operatorId);
  });

  afterAll(async () => {
    await app?.close();
    await teardownClinic(clinic);
    await prisma.$disconnect();
  });

  test("an operator with no membership signs in, which the clinic login refuses", async () => {
    const phone = (
      await prisma.user.findFirstOrThrow({ where: { id: operatorId }, select: { phoneE164: true } })
    ).phoneE164;

    const signedIn = await call("POST", "/platform/login", undefined, {
      identifier: phone,
      password: OPERATOR_PASSWORD,
    });
    expect(signedIn.status).toBe(200);
    expect(JSON.parse(signedIn.text)).toMatchObject({ accessToken: expect.any(String) });

    // The point of the separate door, asserted rather than inferred: the clinic login requires an
    // active membership, and this account has none, so it refuses a perfectly valid operator.
    const refusedByClinic = await call("POST", "/auth/login", undefined, {
      identifier: phone,
      password: OPERATOR_PASSWORD,
    });
    expect(refusedByClinic.status).toBe(401);
  });

  /**
   * **The guard, in the form that cannot be rewritten away.**
   *
   * Queried from a session that binds no tenant — which is what an operator's session is — every
   * clinical and financial table returns zero rows, because RLS says so rather than because a
   * `select` omitted them.
   */
  test("from an unbound session, every clinical and financial table is empty", async () => {
    const counts: Record<string, number> = {};
    for (const table of FORBIDDEN_TABLES) {
      const rows = await prisma.$queryRawUnsafe<{ count: bigint }[]>(
        `SELECT count(*)::bigint AS count FROM ${table}`,
      );
      counts[table] = Number(rows[0]?.count ?? -1);
    }
    expect(counts).toEqual(Object.fromEntries(FORBIDDEN_TABLES.map((table) => [table, 0])));
  });

  test("and the rows really are there for somebody who binds a tenant", async () => {
    // Without this the test above passes on an empty database and proves nothing.
    const visible = await withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) => ({
      patients: await tx.patient.count(),
      visits: await tx.visit.count(),
    }));
    expect(visible.patients).toBeGreaterThan(0);
    expect(visible.visits).toBeGreaterThan(0);
  });

  test("every /platform/* route answers, and none of them carries clinical content", async () => {
    const findings: { name: string; status: number; leaked: boolean }[] = [];
    for (const { name, path } of PLATFORM_ROUTES) {
      const reply = await call("GET", path, operatorToken);
      findings.push({ name, status: reply.status, leaked: reply.text.includes(SENTINEL) });
    }
    expect(findings).toEqual(PLATFORM_ROUTES.map(({ name }) => ({ name, status: 200, leaked: false })));
  });

  describe("the two tokens cannot be exchanged", () => {
    test("a clinic token does not open the platform surface", async () => {
      expect((await call("GET", "/platform/me", clinicToken)).status).toBe(401);
    });

    test("a platform token does not open a clinic route", async () => {
      // It verifies against the same secret — the signature is genuine — so what refuses it is the
      // claim check, not cryptography.
      expect((await call("GET", `/patients/${clinic.patientId}`, operatorToken)).status).toBe(401);
    });

    test("a clinic user with the right password and no flag cannot sign in to the console", async () => {
      // The password is correct, the account is ACTIVE, and the only thing missing is the flag — so
      // a 401 here can have no other cause. Written this way after the first version passed with the
      // flag check deleted, because it was refusing on a wrong password instead.
      const refused = await call("POST", "/platform/login", undefined, {
        identifier: unflaggedPhone,
        password: OPERATOR_PASSWORD,
      });
      expect(refused.status).toBe(401);

      // Not vacuous: the very same credentials open the clinic login.
      const clinicSide = await call("POST", "/auth/login", undefined, {
        identifier: unflaggedPhone,
        password: OPERATOR_PASSWORD,
      });
      expect(clinicSide.status).toBe(200);
    });
  });

  test("the flag is re-read on every request, not trusted from the token", async () => {
    const stillValid = await issuePlatformToken(operatorId);
    expect((await call("GET", "/platform/me", stillValid)).status).toBe(200);

    await withPlatformActor(actorFor(operatorId), (tx) =>
      tx.user.update({ where: { id: operatorId }, data: { isPlatformAdmin: false } }),
    );
    // Same token, same ten-minute life, and it stops working immediately.
    expect((await call("GET", "/platform/me", stillValid)).status).toBe(401);

    await withPlatformActor(actorFor(operatorId), (tx) =>
      tx.user.update({ where: { id: operatorId }, data: { isPlatformAdmin: true } }),
    );
  });
});
