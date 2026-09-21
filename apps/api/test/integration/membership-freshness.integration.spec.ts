import type { AddressInfo } from "node:net";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { uuidv7 } from "uuidv7";
import { AppModule } from "../../src/app.module.ts";
import { issueAccessToken } from "../../src/modules/auth/jwt.ts";
import { refusingValidationPipe } from "../../src/common/validation-pipe.ts";
import { prisma } from "../../src/prisma/client.ts";
import { injected } from "../../src/prisma/injected.ts";
import { withTenant } from "../../src/prisma/with-tenant.ts";
import { generateFixturePhone } from "../fixture-phone.ts";
import { actorFor, type ClinicFixture, seedClinic, teardownClinic } from "./fixtures.ts";

/**
 * **Pilot-readiness 4c: a suspended membership's live token stops on its NEXT request.**
 *
 * An access token is self-contained and lasts fifteen minutes, so suspending somebody does nothing
 * by itself — they keep whatever the token says until it expires. `MembershipFreshnessInterceptor`
 * re-reads the membership on every authenticated request, which is what turns "suspended" into
 * "suspended now". That was asserted nowhere until this file: readiness 4c recorded it as believed
 * rather than tested.
 *
 * Driven against a real clinic route rather than `/auth/me`, because the claim is about the data
 * surface: a suspended receptionist must stop reading the patient book, not merely stop reading
 * their own profile.
 */
describe("a token outlives nothing: the membership is re-read every request", () => {
  let app: NestExpressApplication;
  let baseUrl = "";
  let clinic: ClinicFixture;
  let staffUserId = "";
  let membershipId = "";
  let token = "";

  const call = (bearer: string, path: string): Promise<Response> =>
    fetch(`${baseUrl}${path}`, { headers: { authorization: `Bearer ${bearer}` } });

  const setStatus = async (status: "ACTIVE" | "SUSPENDED"): Promise<void> => {
    await withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) => {
      await tx.membership.update({ where: { id: membershipId }, data: { status } });
    });
  };

  beforeAll(async () => {
    process.env["ATTACHMENTS_STORAGE_ROOT"] ??= process.cwd();
    clinic = await seedClinic();

    const user = await prisma.user.create({
      data: {
        id: uuidv7(),
        phoneE164: generateFixturePhone(),
        passwordHash: "not-a-real-hash",
        fullName: "موظفة استقبال",
        status: "ACTIVE",
      },
    });
    staffUserId = user.id;

    membershipId = await withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) => {
      const id = uuidv7();
      await tx.membership.create({
        data: injected({ id, userId: user.id, role: "RECEPTIONIST", status: "ACTIVE" }),
      });
      return id;
    });

    token = await issueAccessToken({
      sub: staffUserId,
      membershipId,
      tenantId: clinic.tenantId,
      role: "RECEPTIONIST",
    });

    app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: false });
    app.useGlobalPipes(refusingValidationPipe());
    await app.listen(0);
    baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await app?.close();
    await teardownClinic(clinic);
    await prisma.user.delete({ where: { id: staffUserId } }).catch(() => undefined);
    await prisma.$disconnect();
  });

  afterEach(async () => {
    await setStatus("ACTIVE");
  });

  test("the token works while the membership is active", async () => {
    // Without this the test below proves nothing: a 401 from a token that never worked is not a
    // suspension taking effect.
    expect((await call(token, "/patients/recent")).status).toBe(200);
  });

  test("suspending the membership stops that same token on its next request", async () => {
    expect((await call(token, "/patients/recent")).status).toBe(200);

    await setStatus("SUSPENDED");

    // Same token, unexpired, one request later.
    const after = await call(token, "/patients/recent");
    expect(after.status).toBe(401);
    expect(await after.text()).toContain("no longer valid");
  });

  test("it applies to every authenticated surface, not just the one route", async () => {
    await setStatus("SUSPENDED");
    const paths = ["/patients/recent", "/auth/me", `/queue/today?date=${new Date().toISOString().slice(0, 10)}`];
    const statuses = await Promise.all(paths.map(async (path) => (await call(token, path)).status));
    expect(statuses).toEqual(paths.map(() => 401));
  });

  test("a role the membership no longer holds is refused, not honoured", async () => {
    // The other half of freshness: an admin demoted mid-session keeps a token that *says* ADMIN.
    const stale = await issueAccessToken({
      sub: staffUserId,
      membershipId,
      tenantId: clinic.tenantId,
      role: "ADMIN",
    });
    const response = await call(stale, "/patients/recent");
    expect(response.status).toBe(401);
    expect(await response.text()).toContain("no longer valid");
  });

  test("reactivating lets the same token through again", async () => {
    // The refusal is a property of the membership as it stands, not a mark burned onto the token.
    await setStatus("SUSPENDED");
    expect((await call(token, "/patients/recent")).status).toBe(401);

    await setStatus("ACTIVE");
    expect((await call(token, "/patients/recent")).status).toBe(200);
  });
});
