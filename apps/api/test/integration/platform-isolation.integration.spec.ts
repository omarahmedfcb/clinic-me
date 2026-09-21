import { ThrottlingModule } from "../../src/common/throttling.module.ts";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Module } from "@nestjs/common";
import { APP_INTERCEPTOR, NestFactory } from "@nestjs/core";
import { ThrottlerModule } from "@nestjs/throttler";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { apiRoutes } from "../../scripts/route-capabilities.ts";
import { ActorContextInterceptor } from "../../src/common/actor-context.interceptor.ts";
import { refusingValidationPipe } from "../../src/common/validation-pipe.ts";
import { issueAccessToken } from "../../src/modules/auth/jwt.ts";
import { hashPassword } from "../../src/modules/auth/password.ts";
import { AuthController } from "../../src/modules/auth/auth.controller.ts";
import { PatientsController } from "../../src/modules/patients/patients.controller.ts";
import { LocalFilesystemStorageProvider } from "../../src/modules/attachments/storage/local-filesystem.provider.ts";
import { STORAGE_PROVIDER } from "../../src/modules/attachments/storage/storage-provider.ts";
import { PlatformClientFileController } from "../../src/modules/platform/platform-client-file.controller.ts";
import { PlatformClinicsController } from "../../src/modules/platform/platform-clinics.controller.ts";
import { PlatformOperatorsController } from "../../src/modules/platform/platform-operators.controller.ts";
import { PlatformController } from "../../src/modules/platform/platform.controller.ts";
import { issuePlatformToken } from "../../src/modules/platform/platform-token.ts";
import { totpCode } from "../../src/modules/platform/totp.ts";
import { prisma } from "../../src/prisma/client.ts";
import { injected } from "../../src/prisma/injected.ts";
import { withPlatformActor, withTenant } from "../../src/prisma/with-tenant.ts";
import {
  actorFor,
  createTestUser,
  FIXTURE_TOTP_SECRET,
  makeOperator,
  seedClinic,
  teardownClinic,
  type ClinicFixture,
} from "./fixtures.ts";

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
  // The patients controller is mounted here for the leak sweep, and its intake route is
  // rate-limited (4b) — so this module needs the application's own throttler options, not a
  // stand-in: a second `forRoot` is global and would erase every named bucket.
  imports: [ThrottlingModule],
  controllers: [
    PlatformController,
    PlatformClinicsController,
    PlatformOperatorsController,
    PlatformClientFileController,
    PatientsController,
    AuthController,
  ],
  providers: [
    { provide: APP_INTERCEPTOR, useClass: ActorContextInterceptor },
    // The client-file controller streams contract PDFs, so it needs the seam. A temp directory:
    // nothing in this file uploads, and the sweep only reads.
    {
      provide: STORAGE_PROVIDER,
      useFactory: () => new LocalFilesystemStorageProvider(mkdtempSync(path.join(tmpdir(), "platform-iso-"))),
    },
  ],
})
class PlatformTestModule {}

const OPERATOR_PASSWORD = "operator-only-not-a-real-password";
const SENTINEL = "SENTINEL-DIAGNOSIS-the-operator-must-never-see-this";

/**
 * Every `/platform/*` route that reads, **derived from the controllers** rather than listed here.
 *
 * `:tenantId` is substituted with the seeded clinic's id — the clinic that holds the sentinel — so
 * each route is asked the one question that could leak: give me everything you have about the
 * clinic whose visit carries a diagnosis.
 *
 * It was a hand-written list until 2026-09-19, and before 2026-09-15 that list held `/platform/me`
 * alone while its own comment claimed to be every route. A list nobody updates is a sweep that
 * passes while checking almost nothing, and the route that gets added is exactly the one nobody
 * thinks to add here.
 */
const PLATFORM_ROUTES: { name: string; path: string }[] = apiRoutes(
  path.resolve(__dirname, "..", "..", "src"),
  path.resolve(__dirname, "..", "..", "..", ".."),
)
  .filter((route) => route.method === "GET" && route.path.startsWith("/platform"))
  .map((route) => ({ name: route.path, path: route.path }));

/**
 * The four this list held by hand, kept as the floor.
 *
 * Not as the list — as the proof that the derivation above found something. A scanner that quietly
 * stopped matching would return an empty array, sweep nothing, and pass: the exact shape of green
 * guard this project keeps finding.
 */
const ROUTES_THAT_MUST_BE_SWEPT = [
  "/platform/me",
  "/platform/clinics",
  "/platform/operators",
  "/platform/clinics/:tenantId/file",
];

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
    await makeOperator(operatorId, { passwordHash: hashed });

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
    // The production pipe, not a lookalike: its exceptionFactory is what turns a DTO rejection into
    // a refusal code, and a test module with a plain one would assert a shape the app never sends.
    app.useGlobalPipes(refusingValidationPipe());
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
    // **A pending token, not an access token.** The password alone opens nothing from 2026-09-15 —
    // asserted on the field name, because a rename back to `accessToken` would be the change that
    // quietly makes the second factor optional again.
    expect(JSON.parse(signedIn.text)).toMatchObject({
      pendingToken: expect.any(String),
      totpEnrolled: true,
    });
    expect(signedIn.text).not.toContain("accessToken");

    // And it is refused everywhere: the guard demands `full`, so a route added later is behind the
    // second factor by default rather than by being remembered.
    const pending = (JSON.parse(signedIn.text) as { pendingToken: string }).pendingToken;
    expect((await call("GET", "/platform/me", pending)).status).toBe(401);

    // The second factor is what opens it, and the code is computed from the fixture's own secret.
    const code = totpCode(FIXTURE_TOTP_SECRET, Math.floor(Date.now() / 1000));
    const answered = await call("POST", "/platform/totp/verify", pending, { totpCode: code });
    expect({ status: answered.status, hasToken: answered.text.includes("accessToken") }).toEqual({
      status: 200,
      hasToken: true,
    });
    const full = (JSON.parse(answered.text) as { accessToken: string }).accessToken;
    expect((await call("GET", "/platform/me", full)).status).toBe(200);

    // The point of the separate door, asserted rather than inferred: the clinic login requires an
    // active membership, and this account has none, so it refuses a perfectly valid operator.
    const refusedByClinic = await call("POST", "/auth/login", undefined, {
      identifier: phone,
      password: OPERATOR_PASSWORD,
    });
    /**
     * The status **and the body**, because this assertion failed once on 2026-09-15 in a full-suite
     * run and passed alone and in three subsequent full runs. A bare `toBe(401)` says only
     * "received 200" or "received 429", and those are different faults: 200 would mean the operator
     * somehow holds a membership, 429 that an earlier spec exhausted the per-IP login limit —
     * `throttle-isolation` sends 61 logins from 127.0.0.1 against a limit of 60.
     *
     * Unreproduced, so not diagnosed and not claimed fixed. What this does is make the next
     * occurrence name itself instead of costing another three runs.
     */
    expect({ status: refusedByClinic.status, body: refusedByClinic.text.slice(0, 120) }).toEqual({
      status: 401,
      body: expect.stringContaining("Invalid credentials"),
    });
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

  test("the sweep is derived from the route table, and covers the routes it used to list", () => {
    // The list this replaced was maintained by hand, and its own comment claimed to be every route
    // while holding one. Derived now — and asserted non-empty, because an empty sweep is silent.
    expect(PLATFORM_ROUTES.length).toBeGreaterThanOrEqual(ROUTES_THAT_MUST_BE_SWEPT.length);
    for (const path of ROUTES_THAT_MUST_BE_SWEPT) {
      expect(PLATFORM_ROUTES.map((route) => route.path)).toContain(path);
    }
  });

  test("every /platform/* route answers, and none of them carries clinical content", async () => {
    const findings: { name: string; status: number; leaked: boolean }[] = [];
    for (const { name, path } of PLATFORM_ROUTES) {
      // Ids this fixture knows are substituted; anything else gets a well-formed id that exists
      // nowhere, so the route is still *called* and its answer still read for a leak.
      const url = path
        .replace(":tenantId", clinic.tenantId)
        .replace(":userId", operatorId)
        .replace(/:[A-Za-z]+/g, randomUUID());
      const reply = await call("GET", url, operatorToken);
      findings.push({ name, status: reply.status, leaked: reply.text.includes(SENTINEL) });
    }

    // Nothing leaks, whatever it answers.
    expect(findings.filter((finding) => finding.leaked)).toEqual([]);
    // And the addressable ones answer, so "everything 404s" cannot pass this.
    expect(
      findings.filter((finding) => ROUTES_THAT_MUST_BE_SWEPT.includes(finding.name)).map((f) => f.status),
    ).toEqual(ROUTES_THAT_MUST_BE_SWEPT.map(() => 200));
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

    // The role goes with the flag: a CHECK refuses one without the other, which is the constraint
    // added with the operator seats on 2026-09-15.
    await withPlatformActor(actorFor(operatorId), (tx) =>
      tx.user.update({ where: { id: operatorId }, data: { isPlatformAdmin: false, platformRole: null } }),
    );
    // Same token, same ten-minute life, and it stops working immediately.
    expect((await call("GET", "/platform/me", stillValid)).status).toBe(401);

    await makeOperator(operatorId);
  });
});
