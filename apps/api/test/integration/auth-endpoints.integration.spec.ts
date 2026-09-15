import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { NestFactory } from "@nestjs/core";
import { ValidationPipe } from "@nestjs/common";
import cookieParser from "cookie-parser";
import type { NestExpressApplication } from "@nestjs/platform-express";

// swc compiles named exports as non-configurable getters, so jest.spyOn on an imported module
// namespace throws "Cannot redefine property". jest.mock() + requireActual() replaces the module in
// Jest's registry before anything imports it, wrapping only verifyPasswordHash while hashPassword
// stays real. Same pattern as user-lookup.integration.spec.ts.
jest.mock("../../src/modules/auth/password.ts", () => {
  const actual = jest.requireActual("../../src/modules/auth/password.ts");
  return { ...actual, verifyPasswordHash: jest.fn(actual.verifyPasswordHash) };
});

import { hashPassword, verifyPasswordHash } from "../../src/modules/auth/password.ts";
import { AuthModule } from "../../src/modules/auth/auth.module.ts";
import { AUTH_THROTTLE_LIMITS } from "../../src/modules/auth/auth-throttle.ts";
import { prisma } from "../../src/prisma/client.ts";
import { injected } from "../../src/prisma/injected.ts";
import { withTenant } from "../../src/prisma/with-tenant.ts";
import { actorFor, createTestTenant, deleteTestTenant, deleteTestUser } from "./fixtures.ts";

/**
 * The auth endpoints (PHASE-1 §3), over real HTTP through the real module.
 *
 * The app is assembled the way main.ts assembles it — cookie-parser, the global ValidationPipe,
 * `trust proxy` — because three of the properties under test only exist as a consequence of that
 * wiring. A test that mounted the controller bare would pass while the deployed application failed.
 */

const PASSWORD = "correct-horse-battery-staple";
const OTHER_PASSWORD = "not-the-right-password";

interface Actor {
  userId: string;
  phone: string;
  tenantId: string;
  membershipId: string;
}

describe("auth endpoints", () => {
  let app: NestExpressApplication;
  let baseUrl: string;
  let doctor: Actor;
  let secondTenant: { tenantId: string; membershipId: string };
  let outsiderMembershipId: string;
  const cleanup: Array<() => Promise<void>> = [];

  /** Creates a user with a REAL password hash, plus a membership in `tenantId`. */
  async function createActor(tenantId: string, role: "DOCTOR" | "OWNER" = "DOCTOR"): Promise<Actor> {
    const userId = randomUUID();
    const phone = `+2010${String(Math.floor(Math.random() * 9e7) + 1e7).slice(0, 8)}`;
    await prisma.user.create({
      data: {
        id: userId,
        phoneE164: phone,
        passwordHash: await hashPassword(PASSWORD),
        fullName: "Auth Test User",
        status: "ACTIVE",
      },
    });
    cleanup.push(() => deleteTestUser(userId));

    const membershipId = randomUUID();
    await withTenant(tenantId, actorFor(userId), async (tx) => {
      await tx.membership.create({ data: injected({ id: membershipId, userId, role, status: "ACTIVE" }) });
    });
    return { userId, phone, tenantId, membershipId };
  }

  beforeAll(async () => {
    const tenantId = await createTestTenant();
    cleanup.push(() => deleteTestTenant(tenantId));
    doctor = await createActor(tenantId);

    // A second tenant the same user belongs to — the tenant switcher's happy path.
    const otherTenantId = await createTestTenant();
    cleanup.push(() => deleteTestTenant(otherTenantId));
    const secondMembershipId = randomUUID();
    await withTenant(otherTenantId, actorFor(doctor.userId), async (tx) => {
      await tx.membership.create({
        data: injected({ id: secondMembershipId, userId: doctor.userId, role: "OWNER", status: "ACTIVE" }),
      });
    });
    secondTenant = { tenantId: otherTenantId, membershipId: secondMembershipId };

    // A membership belonging to somebody else entirely.
    const outsider = await createActor(otherTenantId, "OWNER");
    outsiderMembershipId = outsider.membershipId;

    app = await NestFactory.create<NestExpressApplication>(AuthModule, { logger: false });
    app.set("trust proxy", 1);
    app.use(cookieParser());
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();
    await app.listen(0, "127.0.0.1");
    const { port } = (app.getHttpServer() as Server).address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await app?.close();
    for (const undo of cleanup.reverse()) await undo().catch(() => undefined);
  });

  interface Reply {
    status: number;
    body: Record<string, unknown>;
    refreshCookie: string | undefined;
  }

  async function call(path: string, options: { body?: unknown; ip?: string; cookie?: string } = {}): Promise<Reply> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (options.ip) headers["x-forwarded-for"] = options.ip;
    if (options.cookie) headers["cookie"] = `clinic_os_refresh=${options.cookie}`;

    const response = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(options.body ?? {}),
    });

    const setCookie = response.headers.getSetCookie?.() ?? [];
    const refresh = setCookie.find((c) => c.startsWith("clinic_os_refresh="));
    const value = refresh?.split(";")[0]?.split("=")[1];

    let body: Record<string, unknown> = {};
    try {
      body = (await response.json()) as Record<string, unknown>;
    } catch {
      body = {};
    }
    return { status: response.status, body, refreshCookie: value && value.length > 0 ? value : undefined };
  }

  /**
   * A fresh actor per test that logs in.
   *
   * The per-identifier rate-limit bucket allows 10 attempts per 15-minute window and the whole
   * suite runs inside one window, so sharing an identifier across tests makes them order-dependent:
   * the eleventh login anywhere in the file starts returning 429 and the failure lands on whichever
   * test happens to be last. That is the limiter working correctly and the test design being wrong.
   */
  async function freshActor(): Promise<Actor> {
    return createActor(doctor.tenantId);
  }

  /** A fresh IP per call, so the per-IP bucket never interferes with a test about something else. */
  let ipCounter = 0;
  const freshIp = (): string => `198.51.${Math.floor(ipCounter / 250) + 1}.${(ipCounter++ % 250) + 1}`;

  // ── 1. phone as identifier ────────────────────────────────────────────────────────────────
  describe("phone is the identifier, in any notation", () => {
    test("Latin digits, national format, and both Arabic-Indic ranges all log the same user in", async () => {
      const national = doctor.phone.replace("+20", "0");
      const toArabicIndic = (s: string, base: number): string =>
        [...s].map((c) => (c >= "0" && c <= "9" ? String.fromCodePoint(base + Number(c)) : c)).join("");

      for (const identifier of [
        doctor.phone,
        national,
        toArabicIndic(national, 0x0660),
        toArabicIndic(national, 0x06f0),
      ]) {
        const reply = await call("/auth/login", { body: { identifier, password: PASSWORD }, ip: freshIp() });
        expect({ identifier, status: reply.status }).toEqual({ identifier, status: 200 });
        expect(reply.refreshCookie).toBeDefined();
      }
    });

    test("the refresh cookie is httpOnly, Secure and SameSite=Strict", async () => {
      const actor = await freshActor();
      // Not cosmetic: httpOnly is what stops an XSS from becoming a session takeover, and it is a
      // property of the Set-Cookie header rather than of any code path a unit test would reach.
      const response = await fetch(`${baseUrl}/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": freshIp() },
        body: JSON.stringify({ identifier: actor.phone, password: PASSWORD }),
      });
      const cookie = (response.headers.getSetCookie?.() ?? []).find((c) => c.startsWith("clinic_os_refresh="));
      expect(cookie).toMatch(/HttpOnly/i);
      expect(cookie).toMatch(/Secure/i);
      expect(cookie).toMatch(/SameSite=Strict/i);
    });

    test("a body carrying an undeclared field is refused, not stripped", async () => {
      const actor = await freshActor();
      // forbidNonWhitelisted. An attempt to smuggle tenantId must be visible, not silently ignored.
      const reply = await call("/auth/login", {
        body: { identifier: actor.phone, password: PASSWORD, tenantId: randomUUID() },
        ip: freshIp(),
      });
      expect(reply.status).toBe(400);
    });
  });

  // ── 2. identical response, including the code path ───────────────────────────────────────
  describe("wrong password and nonexistent account are indistinguishable", () => {
    test("same status and same body", async () => {
      const actor = await freshActor();
      const wrongPassword = await call("/auth/login", {
        body: { identifier: actor.phone, password: OTHER_PASSWORD },
        ip: freshIp(),
      });
      const noSuchAccount = await call("/auth/login", {
        body: { identifier: "+201099999999", password: PASSWORD },
        ip: freshIp(),
      });
      const unparseable = await call("/auth/login", {
        body: { identifier: "not-a-phone-number", password: PASSWORD },
        ip: freshIp(),
      });

      expect(wrongPassword.status).toBe(401);
      expect(noSuchAccount).toEqual(wrongPassword);
      expect(unparseable).toEqual(wrongPassword);
    });

    test("a real Argon2 verify runs even for an identifier that does not parse as a phone number", async () => {
      // The structural assertion, deliberately not a wall-clock one — a timing threshold is flaky
      // in CI and ends up loosened until it proves nothing.
      //
      // This is what a future refactor would break. An early `return` for an unparseable identifier
      // looks like an obvious optimisation and leaves the response body identical, but it skips the
      // hash: the fast path then answers "that account does not exist" in a way an attacker can
      // measure, while every response-body assertion above still passes.
      const mockedVerify = verifyPasswordHash as jest.Mock;
      mockedVerify.mockClear();

      await call("/auth/login", { body: { identifier: "not-a-phone-number", password: PASSWORD }, ip: freshIp() });
      expect(mockedVerify).toHaveBeenCalledTimes(1);

      mockedVerify.mockClear();
      await call("/auth/login", { body: { identifier: "+201099999999", password: PASSWORD }, ip: freshIp() });
      expect(mockedVerify).toHaveBeenCalledTimes(1);
    });
  });

  // ── 3. refresh rotation and family revocation ────────────────────────────────────────────
  describe("refresh rotation", () => {
    test("rotating issues a new pair and the old token stops working", async () => {
      const actor = await freshActor();
      const login = await call("/auth/login", { body: { identifier: actor.phone, password: PASSWORD }, ip: freshIp() });
      const first = login.refreshCookie;
      expect(first).toBeDefined();

      const rotated = await call("/auth/refresh", { ip: freshIp(), cookie: first });
      expect(rotated.status).toBe(200);
      expect(rotated.refreshCookie).toBeDefined();
      expect(rotated.refreshCookie).not.toBe(first);
    });

    test("reusing a consumed token revokes the WHOLE family, not just that token", async () => {
      const actor = await freshActor();
      const login = await call("/auth/login", { body: { identifier: actor.phone, password: PASSWORD }, ip: freshIp() });
      const first = login.refreshCookie;

      const second = await call("/auth/refresh", { ip: freshIp(), cookie: first });
      expect(second.status).toBe(200);
      const live = second.refreshCookie;

      // Replay the consumed token. This is the theft signal.
      const replay = await call("/auth/refresh", { ip: freshIp(), cookie: first });
      expect(replay.status).toBe(401);

      // The descendant issued to the legitimate client is now dead too. Revoking only the replayed
      // token would leave the thief's copy — or the victim's — still working, which is the entire
      // point of family revocation.
      const afterReuse = await call("/auth/refresh", { ip: freshIp(), cookie: live });
      expect(afterReuse.status).toBe(401);
    });

    test("logout revokes the family and is idempotent", async () => {
      const actor = await freshActor();
      const login = await call("/auth/login", { body: { identifier: actor.phone, password: PASSWORD }, ip: freshIp() });
      const token = login.refreshCookie;

      expect((await call("/auth/logout", { ip: freshIp(), cookie: token })).status).toBe(204);
      expect((await call("/auth/refresh", { ip: freshIp(), cookie: token })).status).toBe(401);
      // Again, with no cookie at all: reaching the state you are already in is a success.
      expect((await call("/auth/logout", { ip: freshIp() })).status).toBe(204);
    });
  });

  // ── 4. switch-tenant ─────────────────────────────────────────────────────────────────────
  describe("switch-tenant", () => {
    test("switches into a membership the user does hold", async () => {
      const login = await call("/auth/login", { body: { identifier: doctor.phone, password: PASSWORD }, ip: freshIp() });
      const reply = await call("/auth/switch-tenant", {
        ip: freshIp(),
        cookie: login.refreshCookie,
        body: { membershipId: secondTenant.membershipId },
      });
      expect(reply.status).toBe(200);
      expect(reply.body["accessToken"]).toEqual(expect.any(String));
    });

    test("refuses a membership belonging to somebody else", async () => {
      const login = await call("/auth/login", { body: { identifier: doctor.phone, password: PASSWORD }, ip: freshIp() });
      const reply = await call("/auth/switch-tenant", {
        ip: freshIp(),
        cookie: login.refreshCookie,
        body: { membershipId: outsiderMembershipId },
      });
      expect(reply.status).toBe(401);
    });

    test("a membership that does not exist gets the same answer as one held by someone else", async () => {
      // Otherwise this endpoint enumerates membership ids for an authenticated user.
      const login = await call("/auth/login", { body: { identifier: doctor.phone, password: PASSWORD }, ip: freshIp() });
      const notHeld = await call("/auth/switch-tenant", {
        ip: freshIp(),
        cookie: login.refreshCookie,
        body: { membershipId: outsiderMembershipId },
      });
      const nonexistent = await call("/auth/switch-tenant", {
        ip: freshIp(),
        cookie: login.refreshCookie,
        body: { membershipId: randomUUID() },
      });
      expect(nonexistent.status).toBe(notHeld.status);
      expect(nonexistent.body).toEqual(notHeld.body);
    });

    test("refuses a suspended membership", async () => {
      const suspended = await createActor(doctor.tenantId);
      const login = await call("/auth/login", {
        body: { identifier: suspended.phone, password: PASSWORD },
        ip: freshIp(),
      });
      expect(login.status).toBe(200);

      // Acting as somebody else: a trigger refuses suspending the membership you are acting
      // through (2026-09-12), and this test is about the login, not about that rule.
      await withTenant(suspended.tenantId, actorFor(doctor.userId), async (tx) => {
        await tx.membership.updateMany({ where: { id: suspended.membershipId }, data: { status: "SUSPENDED" } });
      });

      const reply = await call("/auth/switch-tenant", {
        ip: freshIp(),
        cookie: login.refreshCookie,
        body: { membershipId: suspended.membershipId },
      });
      expect(reply.status).toBe(401);
    });
  });

  // ── 5. rate limiting, each bucket proven without the other ───────────────────────────────
  describe("rate limiting", () => {
    test("the per-identifier bucket is NOT bypassed by rotating source addresses", async () => {
      // Every request from a different address, so the per-IP bucket never accumulates. Only the
      // identifier bucket can produce a 429 here. An identifier-keyed limiter is the only thing
      // that stops an attacker who controls a range of addresses.
      const identifier = `+20109${String(Date.now()).slice(-7)}`;
      const statuses: number[] = [];
      for (let attempt = 0; attempt <= AUTH_THROTTLE_LIMITS.identifier; attempt++) {
        const reply = await call("/auth/login", { body: { identifier, password: OTHER_PASSWORD }, ip: freshIp() });
        statuses.push(reply.status);
      }
      expect(statuses.slice(0, AUTH_THROTTLE_LIMITS.identifier)).toEqual(
        Array(AUTH_THROTTLE_LIMITS.identifier).fill(401),
      );
      expect(statuses.at(-1)).toBe(429);
    });

    test("the per-IP bucket catches a spray across many accounts from one address", async () => {
      // Every request a different identifier, so the identifier bucket never accumulates. Only the
      // IP bucket can produce a 429 here.
      const attacker = "203.0.113.200";
      // **Fired concurrently, and that is the fix for this test's intermittency** -- see the note
      // below. Sequentially this is sixty-one HTTP round-trips, each with a database lookup, and it
      // outran Jest's five-second default on a loaded machine.
      const replies = await Promise.all(
        Array.from({ length: AUTH_THROTTLE_LIMITS.ip + 1 }, (_, attempt) =>
          call("/auth/login", {
            body: { identifier: `+2010${String(attempt).padStart(8, "0")}`, password: OTHER_PASSWORD },
            ip: attacker,
          }),
        ),
      );
      const statuses = replies.map((reply) => reply.status);
      /*
       * Asserted as one object so a failure prints the evidence instead of just a length.
       *
       * This test failed once in a full run on 2026-08-30, passed alone, and passed on the six
       * full runs since. The two assertions it had reported only "expected 1, received N", which
       * cannot distinguish the causes: a pre-consumed bucket, an unexpected 500 under load, or a
       * request that never completed. `distinctStatuses` separates them at a glance.
       *
       * The thresholds are unchanged — this is not a weakened assertion. It is strictly stronger:
       * an unexpected status now fails the test rather than being counted as "not 429".
       *
       * The leading hypothesis, that throttler storage is shared between specs so test order
       * decides the result, was tested and **disproved** — see
       * throttle-isolation.integration.spec.ts. The cause is still unknown, and the next red run
       * is where it gets found.
       *
       * **It reddened a second time on 2026-09-09**, in a full `test:integration:no-dotenv` run on
       * the PR 7h branch, and then passed alone and on four consecutive full runs. Two things are
       * worth recording rather than the shrug this would otherwise get.
       *
       * The evidence object printed by the assertion below was **not captured**, because the run's
       * output was filtered at the shell to the lines that usually matter. That is a lesson about
       * how to watch for this, not about the test: the next person to see it red must keep the
       * whole output, since the three fields are the only thing that separates a pre-consumed
       * bucket from an unexpected status from a request that never completed.
       *
       * **Cause found, 2026-09-11: Jest's five-second default test timeout.** The drive above was
       * sixty-one sequential HTTP round-trips, each doing a database lookup. On an idle machine that
       * fits; under a full run it does not, and the test dies of a timeout -- which Jest reports
       * against the test rather than against the assertion, which is why the evidence object never
       * appeared and why the storage hypothesis looked plausible for six weeks.
       *
       * Reproduced deliberately in throttle-isolation.integration.spec.ts, whose identical drive was
       * made to fail on demand with "Exceeded timeout of 5000 ms".
       *
       * The requests are concurrent now, so the drive costs one round-trip's wait instead of
       * sixty-one. The assertion below is weakened in exactly one way, deliberately: `last` is gone,
       * because with concurrent requests the refusal is not guaranteed to be the last response to
       * arrive. What it asserts instead is stronger about the thing that matters -- exactly one
       * refusal, and no status that is neither a 401 nor a 429.
       */
      expect({
        refusals: statuses.filter((s) => s === 429).length,
        distinctStatuses: [...new Set(statuses)].sort((a, b) => a - b),
      }).toEqual({ refusals: 1, distinctStatuses: [401, 429] });
    });

    test("a clinic behind one NAT is not locked out by an attacker elsewhere", async () => {
      // The failure an IP-only limiter produces. The attacker above exhausted 203.0.113.200; a
      // receptionist on a different address, and a different identifier, is unaffected.
      const receptionist = await freshActor();
      const reply = await call("/auth/login", {
        body: { identifier: receptionist.phone, password: PASSWORD },
        ip: freshIp(),
      });
      expect(reply.status).toBe(200);
    });
  });
});
