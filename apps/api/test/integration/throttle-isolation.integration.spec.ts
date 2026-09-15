import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { ThrottlerStorage } from "@nestjs/throttler";
import { AuthModule } from "../../src/modules/auth/auth.module.ts";
import { AUTH_THROTTLE_LIMITS } from "../../src/modules/auth/auth-throttle.ts";
import { prisma } from "../../src/prisma/client.ts";

/**
 * Is the auth throttler's storage shared between Nest applications in one process?
 *
 * **Answered, 2026-09-11: it is not.** `@nestjs/throttler` provides `ThrottlerStorage` through a
 * factory that returns `new ThrottlerStorageService()`, whose `_storage` is an instance `Map`. Each
 * `NestFactory.create()` builds its own container, so each application gets its own store. The
 * first test below asserts that directly rather than inferring it.
 *
 * ## Why this file changed shape
 *
 * It was written to answer that question by *behaviour*: drive one application to the edge of the
 * per-IP limit with 61 sequential HTTP requests, then check the second still accepts that address.
 * That works, and it failed intermittently in full runs while passing alone — which made a
 * structural claim depend on how loaded the machine was.
 *
 * Three candidate causes were ruled out before changing anything, because "widen the wait" would
 * have hidden whichever one was real:
 *
 *   - **shared storage** — ruled out above, by reading the provider and now by assertion;
 *   - **the window expiring mid-drive** — the ttl is fifteen minutes, so 61 requests cannot outrun
 *     it on any machine;
 *   - **a race in the drive** — the loop is sequential and awaits each response.
 *
 * **The real cause, found 2026-09-11: Jest's five-second default test timeout.** The drive makes
 * sixty-one sequential HTTP round-trips, each doing a database lookup. On an idle machine that fits
 * inside five seconds; under a full run it does not, and the test dies of a timeout — which the old
 * form reported as a failed rate-limit assertion, pointing at the storage it was written to suspect.
 *
 * The fix is to remove the cost rather than to extend the clock. The exhausting requests are fired
 * **concurrently**, so the whole drive is one round-trip's worth of waiting instead of sixty-one,
 * and the assertion is "a refusal appeared" rather than "the sixty-first response was the refusal".
 * Nothing about the throttler changed; the test stopped being an endurance run.
 */
describe("auth throttler isolation between applications", () => {
  let appA: NestExpressApplication;
  let appB: NestExpressApplication;
  let urlA: string;
  let urlB: string;

  const SHARED_IP = "203.0.113.77";

  const create = async (): Promise<[NestExpressApplication, string]> => {
    const app = await NestFactory.create<NestExpressApplication>(AuthModule, { logger: false });
    app.set("trust proxy", 1);
    await app.init();
    await app.listen(0, "127.0.0.1");
    const url = `http://127.0.0.1:${((app.getHttpServer() as Server).address() as AddressInfo).port}`;
    return [app, url];
  };

  const attempt = async (base: string, ip: string, identifier: string): Promise<number> => {
    const response = await fetch(`${base}/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": ip },
      body: JSON.stringify({ identifier, password: "definitely-not-the-password" }),
    });
    return response.status;
  };

  beforeAll(async () => {
    [appA, urlA] = await create();
    [appB, urlB] = await create();
  });

  afterAll(async () => {
    if (appA !== undefined) await appA.close();
    if (appB !== undefined) await appB.close();
    await prisma.$disconnect();
  });

  it("each application resolves its own storage instance", async () => {
    // The structural question, asked structurally. Two containers, two stores — and if a future
    // version of the package ever returns a singleton, this fails immediately and says why, rather
    // than surfacing as a rate-limit assertion that only fails when the machine is busy.
    const storeA = appA.get(ThrottlerStorage, { strict: false });
    const storeB = appB.get(ThrottlerStorage, { strict: false });
    expect(storeA).toBeDefined();
    expect(storeB).toBeDefined();
    expect(storeA).not.toBe(storeB);
  });

  it("one application's per-IP budget does not consume another's", async () => {
    // **Fired concurrently.** Sequentially this is sixty-one round-trips and it outran Jest's
    // five-second default on a loaded machine, which is the whole of the intermittency. Every
    // identifier is distinct, so only the IP bucket fills, and one extra request past the limit
    // guarantees a refusal regardless of the order they arrive in.
    const statuses = await Promise.all(
      Array.from({ length: AUTH_THROTTLE_LIMITS.ip + 1 }, (_, i) =>
        attempt(urlA, SHARED_IP, `+2012${String(i).padStart(8, "0")}`),
      ),
    );
    // Non-vacuity: without this the assertion below would pass against a throttler that does
    // nothing at all.
    expect(statuses).toContain(429);

    // The same address, on a second application in the same process.
    const onB = await attempt(urlB, SHARED_IP, "+201299999999");

    // 429 here would mean the storage is process-wide, and every rate-limit assertion in the suite
    // would depend on which spec ran first.
    expect(onB).not.toBe(429);
  });
});
