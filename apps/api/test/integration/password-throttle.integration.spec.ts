import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import cookieParser from "cookie-parser";
import { AuthModule } from "../../src/modules/auth/auth.module.ts";
import { AUTH_THROTTLE_LIMITS } from "../../src/modules/auth/auth-throttle.ts";
import { hashPassword } from "../../src/modules/auth/password.ts";
import { prisma } from "../../src/prisma/client.ts";
import { injected } from "../../src/prisma/injected.ts";
import { withTenant } from "../../src/prisma/with-tenant.ts";
import { actorFor, createTestTenant, deleteTestTenant, deleteTestUser } from "./fixtures.ts";

/**
 * `POST /auth/password` verifies `currentPassword`, so it is guessable and it is now limited.
 *
 * The bucket is keyed on the authenticated user rather than the address, and the second test is the
 * one that matters: a clinic sits behind a single public IP, so an address-keyed limit would let
 * one member of staff lock the whole reception desk out of changing a password.
 *
 * Attempts are fired concurrently, for the reason `throttle-isolation.integration.spec.ts` records
 * at length — a sequential drive of Argon2id verifies is an endurance run that dies of a timeout
 * under a loaded suite and reports it as a failed rate-limit assertion.
 */

const PASSWORD = "correct-horse-battery-staple";
const WRONG = "definitely-not-the-password";

describe("the change-password rate limit", () => {
  let app: NestExpressApplication;
  let baseUrl: string;
  let tenantId: string;
  const cleanup: Array<() => Promise<void>> = [];

  async function createActor(): Promise<{ phone: string; token: string }> {
    const userId = randomUUID();
    const phone = `+2010${String(Math.floor(Math.random() * 9e7) + 1e7).slice(0, 8)}`;
    await prisma.user.create({
      data: {
        id: userId,
        phoneE164: phone,
        passwordHash: await hashPassword(PASSWORD),
        fullName: "Throttle Test User",
        status: "ACTIVE",
      },
    });
    cleanup.push(() => deleteTestUser(userId));

    await withTenant(tenantId, actorFor(userId), async (tx) => {
      await tx.membership.create({ data: injected({ id: randomUUID(), userId, role: "DOCTOR", status: "ACTIVE" }) });
    });

    const login = await fetch(`${baseUrl}/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": freshIp() },
      body: JSON.stringify({ identifier: phone, password: PASSWORD }),
    });
    const body = (await login.json()) as { accessToken?: string };
    expect(login.status).toBe(200);
    expect(typeof body.accessToken).toBe("string");
    return { phone, token: body.accessToken as string };
  }

  /** One wrong-password attempt. Returns the status only. */
  const attempt = async (token: string): Promise<number> => {
    const response = await fetch(`${baseUrl}/auth/password`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
        "x-forwarded-for": freshIp(),
      },
      body: JSON.stringify({ currentPassword: WRONG, newPassword: "a-new-password-entirely" }),
    });
    return response.status;
  };

  let ipCounter = 0;
  const freshIp = (): string => `198.51.${Math.floor(ipCounter / 250) + 1}.${(ipCounter++ % 250) + 1}`;

  beforeAll(async () => {
    tenantId = await createTestTenant();
    cleanup.push(() => deleteTestTenant(tenantId));

    app = await NestFactory.create<NestExpressApplication>(AuthModule, { logger: false });
    app.set("trust proxy", 1);
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    await app.listen(0, "127.0.0.1");
    baseUrl = `http://127.0.0.1:${((app.getHttpServer() as Server).address() as AddressInfo).port}`;
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    for (const undo of cleanup.reverse()) await undo();
  }, 60_000);

  test("refuses with 429 once the user is past the limit", async () => {
    const user = await createActor();
    const over = AUTH_THROTTLE_LIMITS.password + 3;

    const statuses = await Promise.all(Array.from({ length: over }, () => attempt(user.token)));

    // Every attempt carries the wrong password, so the ones that are let through are 401s. The
    // assertion is that a refusal appeared, not that a particular attempt was the one refused:
    // concurrent requests do not arrive in a defined order.
    expect(statuses).toContain(429);
    expect(statuses.every((status) => status === 401 || status === 429)).toBe(true);
    expect(statuses.filter((status) => status === 401).length).toBeLessThanOrEqual(
      AUTH_THROTTLE_LIMITS.password,
    );
  }, 60_000);

  test("one user's exhausted limit does not refuse a colleague on the same address", async () => {
    // The reason the bucket is keyed on the user. Both actors share this process and this host, so
    // an address-keyed limit would fail this test.
    const [first, second] = [await createActor(), await createActor()];

    const exhausted = await Promise.all(
      Array.from({ length: AUTH_THROTTLE_LIMITS.password + 3 }, () => attempt(first.token)),
    );
    expect(exhausted).toContain(429);

    expect(await attempt(second.token)).toBe(401);
  }, 60_000);
});
