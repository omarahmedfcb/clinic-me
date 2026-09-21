import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Module } from "@nestjs/common";
import { APP_INTERCEPTOR, NestFactory } from "@nestjs/core";
import { ThrottlerModule } from "@nestjs/throttler";
import cookieParser from "cookie-parser";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { ActorContextInterceptor } from "../../src/common/actor-context.interceptor.ts";
import { refusingValidationPipe } from "../../src/common/validation-pipe.ts";
import { AuthController } from "../../src/modules/auth/auth.controller.ts";
import { hashPassword } from "../../src/modules/auth/password.ts";
import { prisma } from "../../src/prisma/client.ts";
import { injected } from "../../src/prisma/injected.ts";
import { withPlatformActor, withTenant } from "../../src/prisma/with-tenant.ts";
import { actorFor, createTestTenant, createTestUser } from "./fixtures.ts";

/**
 * **«تذكرني» is granted by role, on the server** — the guard the 2026-09-15 brief asks for.
 *
 * The brief: *"«تذكرني» for DOCTOR and RECEPTIONIST only (30-day refresh token on that device;
 * never ADMIN/OWNER/operator — guard)."*
 *
 * The thing worth guarding is not the checkbox. It is that `POST /auth/login` is reachable without
 * the screen at all, so an ADMIN sending `rememberMe: true` by hand must still get a session cookie
 * — a UI that hides the box is a suggestion, and this asserts the decision is taken where it cannot
 * be bypassed.
 *
 * Read off the `Set-Cookie` header rather than from application state: `Max-Age` is the whole
 * observable difference, and it is the browser that acts on it.
 */

const PASSWORD = "remember-me-not-a-real-password";
const THIRTY_DAYS = 30 * 24 * 60 * 60;

@Module({
  imports: [ThrottlerModule.forRoot([{ name: "default", ttl: 60_000, limit: 1_000 }])],
  controllers: [AuthController],
  providers: [{ provide: APP_INTERCEPTOR, useClass: ActorContextInterceptor }],
})
class AuthTestModule {}

interface Seat {
  userId: string;
  phone: string;
  role: string;
}

describe("remember me", () => {
  let app: NestExpressApplication;
  let baseUrl = "";
  let tenantId = "";
  const seats = new Map<string, Seat>();

  const login = async (phone: string, rememberMe?: boolean) => {
    const response = await fetch(`${baseUrl}/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ identifier: phone, password: PASSWORD, ...(rememberMe === undefined ? {} : { rememberMe }) }),
    });
    return { status: response.status, cookies: response.headers.getSetCookie() };
  };

  /** The refresh cookie's `Max-Age`, or null when the browser is told to drop it on close. */
  const refreshMaxAge = (cookies: string[]): number | null => {
    const cookie = cookies.find((value) => value.startsWith("clinic_os_refresh="));
    if (cookie === undefined) throw new Error("no refresh cookie was set");
    const maxAge = /Max-Age=(\d+)/i.exec(cookie)?.[1];
    return maxAge === undefined ? null : Number(maxAge);
  };

  beforeAll(async () => {
    tenantId = await createTestTenant();
    const hashed = await hashPassword(PASSWORD);

    for (const role of ["DOCTOR", "RECEPTIONIST", "ADMIN", "OWNER"]) {
      const userId = await createTestUser();
      // Through `withPlatformActor`: `users_audit` refuses an UPDATE with no actor bound (D16), and
      // this row has no tenant to bind one through yet.
      const phone = (
        await withPlatformActor(actorFor(userId), (tx) =>
          tx.user.update({ where: { id: userId }, data: { passwordHash: hashed }, select: { phoneE164: true } }),
        )
      ).phoneE164;

      await withTenant(tenantId, actorFor(userId), (tx) =>
        tx.membership.create({
          data: injected({ id: randomUUID(), userId, role: role as "DOCTOR", status: "ACTIVE" }),
        }),
      );
      seats.set(role, { userId, phone, role });
    }

    app = await NestFactory.create<NestExpressApplication>(AuthTestModule, { logger: false });
    app.use(cookieParser());
    app.useGlobalPipes(refusingValidationPipe());
    await app.listen(0, "127.0.0.1");
    baseUrl = `http://127.0.0.1:${((app.getHttpServer() as Server).address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await app?.close();

    /*
     * Clean up after itself, like every other fixture here.
     *
     * The first version of this spec created a tenant and four users and left them, which is untidy
     * rather than harmful — the test database is disposable — but every login in this file is an
     * `auth_throttle` bucket and a `refresh_tokens` family, and leaving those to accumulate across
     * runs is exactly the kind of shared state that makes a suite fail once in four runs and pass
     * when anybody looks at it.
     *
     * Best-effort for the reason `teardownClinic` documents at length: the append-only triggers make
     * some rows undeletable by design, and one failed statement poisons the whole transaction.
     */
    for (const seat of seats.values()) {
      await prisma.refreshToken.deleteMany({ where: { userId: seat.userId } }).catch(() => undefined);
    }
    await withTenant(tenantId, actorFor(seats.get("DOCTOR")?.userId ?? ""), (tx) =>
      tx.membership.deleteMany({}),
    ).catch(() => undefined);
    for (const seat of seats.values()) {
      await prisma.user.delete({ where: { id: seat.userId } }).catch(() => undefined);
    }
    await prisma.tenant.delete({ where: { id: tenantId } }).catch(() => undefined);

    await prisma.$disconnect();
  });

  test("a DOCTOR and a RECEPTIONIST who ask are remembered for thirty days", async () => {
    const answers: Record<string, number | null> = {};
    for (const role of ["DOCTOR", "RECEPTIONIST"]) {
      const result = await login(seats.get(role)?.phone ?? "", true);
      expect({ role, status: result.status }).toEqual({ role, status: 200 });
      answers[role] = refreshMaxAge(result.cookies);
    }
    expect(answers).toEqual({ DOCTOR: THIRTY_DAYS, RECEPTIONIST: THIRTY_DAYS });
  });

  /** **The half that matters.** The request is identical; the role is what refuses it. */
  test("an ADMIN and an OWNER asking for the same thing get a session cookie anyway", async () => {
    const answers: Record<string, number | null> = {};
    for (const role of ["ADMIN", "OWNER"]) {
      const result = await login(seats.get(role)?.phone ?? "", true);
      expect({ role, status: result.status }).toEqual({ role, status: 200 });
      answers[role] = refreshMaxAge(result.cookies);
    }
    // null: no Max-Age at all, so the browser drops it when the window closes.
    expect(answers).toEqual({ ADMIN: null, OWNER: null });
  });

  test("and nobody is remembered who did not ask", async () => {
    const answers: Record<string, number | null> = {};
    for (const role of ["DOCTOR", "RECEPTIONIST", "ADMIN", "OWNER"]) {
      answers[role] = refreshMaxAge((await login(seats.get(role)?.phone ?? "")).cookies);
    }
    expect(answers).toEqual({ DOCTOR: null, RECEPTIONIST: null, ADMIN: null, OWNER: null });
  });

  /**
   * The marker cookie exists so a rotation does not silently downgrade a remembered session.
   *
   * Without it the checkbox appears to work and stops working at the first token refresh — fifteen
   * minutes later — which is the kind of defect nobody reproduces because by then the user has
   * simply signed in again.
   */
  test("a remembered session carries a marker, and a session one clears it", async () => {
    const remembered = await login(seats.get("DOCTOR")?.phone ?? "", true);
    const marker = remembered.cookies.find((value) => value.startsWith("clinic_os_remember="));
    expect(marker).toBeDefined();
    expect(/Max-Age=(\d+)/i.exec(marker ?? "")?.[1]).toBe(String(THIRTY_DAYS));

    const plain = await login(seats.get("ADMIN")?.phone ?? "", true);
    const cleared = plain.cookies.find((value) => value.startsWith("clinic_os_remember="));
    // Cleared, not absent: an ADMIN signing in on a browser that remembers a doctor must not
    // inherit that browser's marker.
    expect(cleared).toBeDefined();
    expect(/Max-Age=0|Expires=Thu, 01 Jan 1970/i.test(cleared ?? "")).toBe(true);
  });

  test("every refresh cookie is still httpOnly, Secure and SameSite=Strict", async () => {
    // The brief changes how long a cookie lives and nothing else. Asserted because "remember me"
    // is exactly the change somebody could implement by relaxing one of these instead.
    const cookies = (await login(seats.get("DOCTOR")?.phone ?? "", true)).cookies;
    const refresh = cookies.find((value) => value.startsWith("clinic_os_refresh=")) ?? "";
    expect({
      httpOnly: /HttpOnly/i.test(refresh),
      secure: /Secure/i.test(refresh),
      strict: /SameSite=Strict/i.test(refresh),
    }).toEqual({ httpOnly: true, secure: true, strict: true });
  });
});
