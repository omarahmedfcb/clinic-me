import { mkdtempSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { AppModule } from "../../src/app.module.ts";
import { prisma } from "../../src/prisma/client.ts";

/**
 * **The real `AppModule` boots, and its guards resolve.**
 *
 * Every other integration spec assembles a small module of its own with exactly the controllers and
 * providers it needs — which is right for testing a route, and blind to the one failure that only
 * the real graph has: a controller whose guard depends on a provider no module supplies it.
 *
 * `@UseGuards(ThrottlerGuard)` on the platform login is the live example. `ThrottlerModule.forRoot`
 * is configured in `AuthModule`; the platform controller is in a different module. It happens to
 * work because that module is `@Global()`, but *reading that* is not the same as watching it. Nest
 * resolves dependencies at `NestFactory.create`, which `npm run build` never reaches and no other
 * test here reached either — so a missing import would have shipped compiling and green.
 *
 * Deliberately thin: it boots and asks for two unauthenticated answers. Anything more belongs to
 * the spec that owns the route.
 */
describe("the application assembles", () => {
  let app: NestExpressApplication;
  let baseUrl: string;
  let previousStorageRoot: string | undefined;

  beforeAll(async () => {
    /**
     * `AttachmentsModule` refuses to boot without a storage root, and refuses to default one —
     * deliberately, because every candidate default fails silently. CI sets only the four variables
     * the integration suite needed before this spec existed, so the boot found none.
     *
     * Supplied here rather than added to the workflow: a deployment provides this, so the spec
     * should too, and `npm run test:integration:no-dotenv` — which reproduces CI's bare environment
     * and is what caught this — then passes locally for the same reason it passes there.
     */
    previousStorageRoot = process.env["ATTACHMENTS_STORAGE_ROOT"];
    process.env["ATTACHMENTS_STORAGE_ROOT"] ??= mkdtempSync(join(tmpdir(), "app-module-boots-"));

    // `abortOnError: false` is load-bearing. Nest's default teardown calls `process.exit(1)` on a
    // boot failure, which kills the worker and reports "process.exit called with 1" — the failure
    // is loud and says nothing about its cause. This makes it a rejected promise jest can print.
    app = await NestFactory.create<NestExpressApplication>(AppModule, {
      logger: false,
      abortOnError: false,
    });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.listen(0, "127.0.0.1");
    baseUrl = `http://127.0.0.1:${((app.getHttpServer() as Server).address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await app?.close();
    // Restored, because `--runInBand` shares one process: a variable left set here would silently
    // satisfy a later spec that ought to have failed without it.
    if (previousStorageRoot === undefined) delete process.env["ATTACHMENTS_STORAGE_ROOT"];
    else process.env["ATTACHMENTS_STORAGE_ROOT"] = previousStorageRoot;
    await prisma.$disconnect();
  });

  test("it boots at all, which is the whole point", () => {
    expect(baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  test("the throttled platform login resolves its guard and refuses bad credentials", async () => {
    const response = await fetch(`${baseUrl}/platform/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ identifier: "+201999999999", password: "definitely-wrong" }),
    });
    // 401, not 500. A 500 here is an unresolved `ThrottlerGuard`, which is the failure this exists
    // to catch — the credentials are wrong either way, so the status is the whole signal.
    expect(response.status).toBe(401);
  });

  test("the platform surface refuses an unauthenticated caller", async () => {
    expect((await fetch(`${baseUrl}/platform/me`)).status).toBe(401);
  });
});
