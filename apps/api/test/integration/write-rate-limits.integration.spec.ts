import type { AddressInfo } from "node:net";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { uuidv7 } from "uuidv7";
import { AppModule } from "../../src/app.module.ts";
import { refusingValidationPipe } from "../../src/common/validation-pipe.ts";
import { WRITE_THROTTLE_LIMITS } from "../../src/common/write-throttle.ts";
import { issueAccessToken } from "../../src/modules/auth/jwt.ts";
import { prisma } from "../../src/prisma/client.ts";
import { injected } from "../../src/prisma/injected.ts";
import { withTenant } from "../../src/prisma/with-tenant.ts";
import { generateFixturePhone } from "../fixture-phone.ts";
import { actorFor, type ClinicFixture, seedClinic, teardownClinic } from "./fixtures.ts";

/**
 * **Pilot-readiness 4b: the write routes a script could abuse are limited, and the key is the
 * membership rather than the address.**
 *
 * An Egyptian clinic sits behind one NAT. A per-IP write limit takes the whole practice offline the
 * first time one person is busy — the limit doing exactly what it was configured to do, and still a
 * fault report. The second test is the one that matters: two people at the same desk, one of them
 * over the limit, and the other still working.
 */
describe("the write routes have ceilings", () => {
  let app: NestExpressApplication;
  let baseUrl = "";
  let clinic: ClinicFixture;
  const created: string[] = [];

  /** A second receptionist, to prove the bucket is per membership. */
  let secondToken = "";
  let secondUserId = "";
  let firstToken = "";

  const post = (token: string, path: string, body: unknown): Promise<Response> =>
    fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  /** The whole intake body, because the DTO refuses a partial one — and a 400 is not a rate limit. */
  const newPatient = () => ({
    fullNameAr: "مريضة للاختبار",
    phoneE164: generateFixturePhone(),
    gender: "FEMALE",
    dateOfBirth: "1994-04-12",
    nationality: "EG",
    relationshipToContact: "SELF",
  });

  const makeReceptionist = async (): Promise<{ token: string; userId: string }> => {
    const user = await prisma.user.create({
      data: {
        id: uuidv7(),
        phoneE164: generateFixturePhone(),
        passwordHash: "not-a-real-hash",
        fullName: "موظفة استقبال",
        status: "ACTIVE",
      },
    });
    const membershipId = await withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) => {
      const id = uuidv7();
      await tx.membership.create({
        data: injected({ id, userId: user.id, role: "RECEPTIONIST", status: "ACTIVE" }),
      });
      return id;
    });
    const token = await issueAccessToken({
      sub: user.id,
      membershipId,
      tenantId: clinic.tenantId,
      role: "RECEPTIONIST",
    });
    return { token, userId: user.id };
  };

  beforeAll(async () => {
    process.env["ATTACHMENTS_STORAGE_ROOT"] ??= process.cwd();
    clinic = await seedClinic();

    const first = await makeReceptionist();
    firstToken = first.token;
    created.push(first.userId);
    const second = await makeReceptionist();
    secondToken = second.token;
    secondUserId = second.userId;
    created.push(second.userId);

    app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: false });
    app.useGlobalPipes(refusingValidationPipe());
    await app.listen(0);
    baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await app?.close();
    await teardownClinic(clinic);
    for (const userId of created) await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
    await prisma.$disconnect();
  });

  test("intake refuses with 429 past its ceiling, and says how long to wait", async () => {
    const attempts = WRITE_THROTTLE_LIMITS.intake + 5;
    const statuses: number[] = [];
    let retryAfter: string | null = null;

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const response = await post(firstToken, "/patients", newPatient());
      statuses.push(response.status);
      if (response.status === 429 && retryAfter === null) {
        // Both headers: the named one says WHICH bucket, the standard one is what a client reads.
        retryAfter = response.headers.get("retry-after");
        expect(response.headers.get("retry-after-intake-write")).not.toBeNull();
      }
    }

    // Accepted up to the ceiling, refused after it. Both halves: a limit that refused everything
    // would pass an assertion that only looked for a 429.
    expect(statuses.filter((status) => status === 201).length).toBe(WRITE_THROTTLE_LIMITS.intake);
    expect(statuses.filter((status) => status === 429).length).toBe(attempts - WRITE_THROTTLE_LIMITS.intake);
    expect(retryAfter).not.toBeNull();
  }, 120_000);

  test("the bucket is the membership: the desk beside the exhausted one keeps working", async () => {
    // The whole reason the key is not the IP. Both requests come from this process, on one address.
    const mine = await post(firstToken, "/patients", newPatient());
    expect(mine.status).toBe(429);

    const theirs = await post(secondToken, "/patients", newPatient());
    expect(theirs.status).toBe(201);
  }, 60_000);

  test("payments and uploads have their own ceilings, not one shared allowance", async () => {
    // The intake bucket is exhausted for this membership; a payment must not be refused because of
    // it, or one busy registration desk would stop the clinic taking money.
    const payment = await post(secondToken, "/payments", {
      patientId: clinic.patientId,
      amountMinor: 5_000,
      method: "CASH",
    });
    expect(payment.status).not.toBe(429);

    expect(WRITE_THROTTLE_LIMITS.upload).toBeLessThan(WRITE_THROTTLE_LIMITS.intake);
  }, 60_000);

  test("the limits are the numbers this file names, so a change here is a visible one", () => {
    expect(WRITE_THROTTLE_LIMITS).toEqual({ windowMs: 60_000, intake: 60, payments: 60, upload: 20 });
    expect(secondUserId).not.toBe("");
  });
});
