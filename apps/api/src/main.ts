import "reflect-metadata";
import "dotenv/config";
import { ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import cookieParser from "cookie-parser";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { AppModule } from "./app.module.ts";
import { assertTimezoneDataAvailable } from "./common/timezone-support.ts";

/**
 * Reads a boolean-ish environment variable. Anything other than an explicit truthy value is false,
 * so a typo disables a setting rather than silently enabling it.
 */
function envFlag(name: string): boolean {
  const value = process.env[name];
  return value === "1" || value === "true";
}

async function bootstrap(): Promise<void> {
  /**
   * Before anything else, and before any port is bound. A runtime without IANA timezone data does
   * not fail on an unknown zone -- it silently resolves it to UTC, and every appointment would be
   * booked one or two hours off with nothing anywhere reporting an error. Refusing to start is the
   * only honest response: a container that serves wrong times is worse than one that does not
   * start, because the second kind gets noticed.
   */
  assertTimezoneDataAvailable();

  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  /**
   * TRUST_PROXY is a correctness setting, not a deployment convenience.
   *
   * Behind a reverse proxy every request arrives from the proxy's address, and Express reports
   * that as `req.ip` unless told otherwise. `withTenant()` binds `app.current_ip` into the audit
   * trail from exactly that value (SCHEMA-DECISIONS.md D16), so without this every audit row in
   * the system records the proxy instead of the person — quietly, uniformly, and in a table that
   * is append-only and cannot be corrected afterwards.
   *
   * It is opt-in rather than always-on because trusting X-Forwarded-For when nothing is stripping
   * it lets a client forge its own IP into the audit log. Set it only where a proxy really is in
   * front, and set it to the number of proxies rather than `true`: `1` trusts exactly the last
   * hop, which is Caddy, and ignores anything a client appended before it.
   */
  const trustProxy = process.env["TRUST_PROXY"];
  if (trustProxy !== undefined && trustProxy !== "") {
    const hops = Number.parseInt(trustProxy, 10);
    app.set("trust proxy", Number.isNaN(hops) ? trustProxy : hops);
  }

  /**
   * CORS is off unless an origin list is supplied, and in the intended deployment it stays off:
   * Caddy serves the SPA and proxies the API on one hostname, so the browser makes same-origin
   * requests and never sends a preflight. The setting exists for a deployment that splits them.
   *
   * There is deliberately no wildcard branch. `origin: true` reflects whatever Origin the caller
   * sent, which with `credentials: true` means any site can make authenticated requests on a
   * logged-in user's behalf.
   */
  const corsOrigins = (process.env["CORS_ORIGINS"] ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
  if (corsOrigins.length > 0) {
    app.enableCors({ origin: corsOrigins, credentials: true });
  }

  /**
   * The refresh token is an httpOnly cookie, and Express 5 does not parse cookies on its own -- a
   * request would arrive with `req.cookies` undefined and every refresh would read as "not
   * authenticated". Registered before the routes so it applies to all of them.
   */
  app.use(cookieParser());

  /**
   * DTO validation at the boundary (CLAUDE.md, ARCHITECTURE.md §17). Global, so it cannot be
   * forgotten on a new controller — the failure mode of a per-route pipe is that the route which
   * needed it most is the one nobody remembered to decorate.
   *
   * `whitelist` strips any property no DTO declares. `forbidNonWhitelisted` rejects the request
   * outright instead, and the difference matters for this system specifically: stripping silently
   * accepts a request carrying `tenantId` and processes it as though the caller never sent one.
   * Rejecting means an attempt to smuggle a field is a 400 that someone can see, which is the same
   * reasoning as TenantGuard logging a body-supplied tenantId rather than quietly ignoring it.
   *
   * `transform` turns a plain body into an instance of the DTO class, so declared types are real at
   * runtime rather than whatever JSON.parse produced.
   */
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      // Without this, every numeric or boolean field arriving as a string from a query parameter
      // needs its own @Type decorator, and the one that is forgotten fails at the database instead.
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  /**
   * Graceful shutdown. Without this, SIGTERM kills the process with the Prisma pool still holding
   * connections; Postgres reclaims them on its own timeline, and a deploy that restarts the API
   * repeatedly can exhaust `max_connections` before the first ones drop.
   *
   * This works only because the container runs `node` as PID 1 (no shell wrapper in the
   * Dockerfile's CMD) — otherwise the signal never reaches this process at all.
   */
  app.enableShutdownHooks();

  const port = process.env["PORT"] ?? 3000;
  await app.listen(port);
}

// A rejected bootstrap must exit non-zero, or an orchestrator sees a healthy container that is
// serving nothing. Node's default for an unhandled rejection is a warning, not an exit code.
bootstrap().catch((error: unknown) => {
  console.error("Failed to start:", error);
  process.exit(1);
});
