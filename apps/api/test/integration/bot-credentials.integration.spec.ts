import type { AddressInfo } from "node:net";
import { ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { AppModule } from "../../src/app.module.ts";
import { issueAccessToken } from "../../src/modules/auth/jwt.ts";
import { prisma } from "../../src/prisma/client.ts";
import { injected } from "../../src/prisma/injected.ts";
import { withTenant } from "../../src/prisma/with-tenant.ts";
import { generateFixturePhone } from "../fixture-phone.ts";
import { actorFor, type ClinicFixture, seedClinic, teardownClinic } from "./fixtures.ts";

/**
 * The bot's credential: issued and revoked by the clinic, hashed at rest, one live at a time.
 *
 * The revocation test is the one that matters most. A credential whose revocation only stops the
 * *next* sign-in leaves the bot working until its access token expires — which is the gap 4c names
 * for staff, and a bot's token is handed to software outside our network.
 */
describe("the bot credential", () => {
  let app: NestExpressApplication;
  let baseUrl = "";
  let clinic: ClinicFixture;
  let adminToken = "";
  let adminUserId = "";

  const call = (token: string, method: string, url: string, body?: unknown): Promise<Response> =>
    fetch(`${baseUrl}${url}`, {
      method,
      headers: {
        ...(token === "" ? {} : { authorization: `Bearer ${token}` }),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  const issue = async (): Promise<{ credentialId: string; secret: string }> => {
    const response = await call(adminToken, "POST", "/clinic/bot-credential");
    expect(response.status).toBe(201);
    return (await response.json()) as { credentialId: string; secret: string };
  };

  const revoke = (): Promise<Response> => call(adminToken, "POST", "/clinic/bot-credential/revoke");

  // Only the two fields: the issue response also carries a one-time notice, and the API refuses a
  // body with a field it does not expect — which is the behaviour, not a wrinkle to work around.
  const tokenFor = async (credential: { credentialId: string; secret: string }): Promise<Response> =>
    call("", "POST", "/bot/auth/token", { credentialId: credential.credentialId, secret: credential.secret });

  beforeAll(async () => {
    process.env["ATTACHMENTS_STORAGE_ROOT"] ??= process.cwd();
    clinic = await seedClinic();

    // A separate admin: a database guard refuses a user changing their own role, which is exactly
    // right and means the fixture cannot promote the clinic user it already has.
    const admin = await prisma.user.create({
      data: {
        id: crypto.randomUUID(),
        phoneE164: generateFixturePhone(),
        passwordHash: "not-a-real-hash",
        fullName: "مسؤولة العيادة",
        status: "ACTIVE",
      },
    });
    adminUserId = admin.id;
    const adminMembershipId = await withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) => {
      const id = crypto.randomUUID();
      await tx.membership.create({ data: injected({ id, userId: admin.id, role: "ADMIN", status: "ACTIVE" }) });
      return id;
    });
    adminToken = await issueAccessToken({
      sub: admin.id,
      membershipId: adminMembershipId,
      tenantId: clinic.tenantId,
      role: "ADMIN",
    });

    app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: false });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.listen(0);
    baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await app?.close();
    await teardownClinic(clinic);
    await prisma.user.delete({ where: { id: adminUserId } }).catch(() => undefined);
    await prisma.$disconnect();
  });

  afterEach(async () => {
    await revoke().catch(() => undefined);
  });

  test("is issued with a secret shown once, and the secret is never stored", async () => {
    const credential = await issue();
    expect(credential.secret.length).toBeGreaterThan(20);

    const stored = await withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) =>
      tx.botCredential.findFirstOrThrow({ where: { id: credential.credentialId }, select: { secretHash: true } }),
    );
    expect(stored.secretHash).toMatch(/^\$argon2id\$/);
    expect(stored.secretHash).not.toContain(credential.secret);

    // And there is no route that reads it back.
    const read = await call(adminToken, "GET", "/clinic/bot-credential");
    expect(read.status).toBe(200);
    expect(await read.text()).not.toContain(credential.secret);
  });

  test("a second one is refused while the first is live", async () => {
    await issue();
    const second = await call(adminToken, "POST", "/clinic/bot-credential");
    expect(second.status).toBe(409);
  });

  test("after revoking, a new one can be issued", async () => {
    await issue();
    expect((await revoke()).status).toBe(201);
    const again = await call(adminToken, "POST", "/clinic/bot-credential");
    expect(again.status).toBe(201);
  });

  test("the credential exchanges for a token that reaches the bot surface", async () => {
    const credential = await issue();
    const token = await tokenFor(credential);
    expect(token.status).toBe(201);

    const { accessToken } = (await token.json()) as { accessToken: string };
    const lookup = await call(accessToken, "GET", `/bot/patients?phone=${encodeURIComponent(generateFixturePhone())}`);
    expect(lookup.status).toBe(200);
  });

  test("a wrong secret, a revoked credential and an unknown id are one answer", async () => {
    const credential = await issue();

    const wrongSecret = await tokenFor({ credentialId: credential.credentialId, secret: "x".repeat(43) });
    expect(wrongSecret.status).toBe(401);

    const unknown = await tokenFor({ credentialId: "00000000-0000-7000-8000-000000000000", secret: credential.secret });
    expect(unknown.status).toBe(401);

    await revoke();
    const revoked = await tokenFor(credential);
    expect(revoked.status).toBe(401);

    // The same code for all three: which one it was is not the caller's business.
    for (const response of [wrongSecret, unknown, revoked]) {
      expect(await response.text()).toContain('"code":"INVALID_CREDENTIAL"');
    }
  });

  /** 4c's shape, for the bot: the token already minted stops working on its next request. */
  test("revoking kills a live token on its NEXT request, not at its expiry", async () => {
    const credential = await issue();
    const { accessToken } = (await (await tokenFor(credential)).json()) as { accessToken: string };

    const before = await call(accessToken, "GET", `/bot/patients?phone=${encodeURIComponent(generateFixturePhone())}`);
    expect(before.status).toBe(200);

    expect((await revoke()).status).toBe(201);

    const after = await call(accessToken, "GET", `/bot/patients?phone=${encodeURIComponent(generateFixturePhone())}`);
    expect([401, 403]).toContain(after.status);
  });

  test("only clinicSettings.manage may issue or revoke", async () => {
    const receptionUserId = await withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) => {
      const user = await prisma.user.create({
        data: {
          id: crypto.randomUUID(),
          phoneE164: generateFixturePhone(),
          passwordHash: "not-a-real-hash",
          fullName: "موظفة استقبال",
          status: "ACTIVE",
        },
      });
      await tx.membership.create({
        data: injected({ id: crypto.randomUUID(), userId: user.id, role: "RECEPTIONIST", status: "ACTIVE" }),
      });
      return user.id;
    });

    const membershipId = await withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) =>
      (await tx.membership.findFirstOrThrow({ where: { userId: receptionUserId }, select: { id: true } })).id,
    );
    const receptionToken = await issueAccessToken({
      sub: receptionUserId,
      membershipId,
      tenantId: clinic.tenantId,
      role: "RECEPTIONIST",
    });

    expect((await call(receptionToken, "POST", "/clinic/bot-credential")).status).toBe(403);
    expect((await call(receptionToken, "POST", "/clinic/bot-credential/revoke")).status).toBe(403);
    expect((await call(receptionToken, "GET", "/clinic/bot-credential")).status).toBe(403);
  });

  test("issuing and revoking are audited under the person who did it, and never carry the hash", async () => {
    const credential = await issue();
    await revoke();

    const rows = await withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) =>
      tx.auditLog.findMany({
        where: { entityType: "bot_credentials", entityId: credential.credentialId },
        select: { action: true, actorUserId: true, actorRole: true, newState: true },
      }),
    );

    expect(rows.map((row) => row.action).sort()).toEqual(["CREATE", "UPDATE"]);
    expect(rows.every((row) => row.actorUserId === adminUserId)).toBe(true);
    expect(rows.every((row) => row.actorRole === "ADMIN")).toBe(true);
    for (const row of rows) {
      expect(JSON.stringify(row.newState)).toContain('"secret_hash":"(redacted)"');
      expect(JSON.stringify(row.newState)).not.toContain("$argon2id$");
    }
  });
});
