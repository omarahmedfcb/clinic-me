import { createHmac, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { AppModule } from "../../src/app.module.ts";
import { refusingValidationPipe } from "../../src/common/validation-pipe.ts";
import { mintSlotToken, SLOT_TOKEN_TTL_MS } from "../../src/modules/appointments/slot-token.ts";
import { issueAccessToken } from "../../src/modules/auth/jwt.ts";
import { injected } from "../../src/prisma/injected.ts";
import { withTenant } from "../../src/prisma/with-tenant.ts";
import { actorFor, createTestUser, deleteTestUser, seedClinic, teardownClinic, type ClinicFixture } from "./fixtures.ts";

// A page left open past the token's ten minutes must be refused as a 400 the screen can word, never a
// 500. Stage 5 retired the seven-field shape: it is INVALID_TOKEN whether stale or fresh.
describe("a slot offered more than ten minutes ago is refused cleanly", () => {
  let app: NestExpressApplication;
  let baseUrl = "";
  let clinic: ClinicFixture;
  let botUserId = "";
  const tokens = { reception: "", bot: "" };
  let booked = "";

  const issuedLongAgo = new Date(Date.now() - SLOT_TOKEN_TTL_MS - 60_000);
  const futureSlot = (hour: number) => {
    const start = Date.parse("2031-06-02T00:00:00Z") + hour * 3_600_000;
    return { startMs: start, endMs: start + 30 * 60_000 };
  };
  const sevenField = (expiresAtMs: number): string => {
    const slot = futureSlot(9);
    const body = [clinic.tenantId, clinic.doctorId, clinic.serviceId, slot.startMs, slot.endMs, expiresAtMs, "ab12"].join(".");
    const signature = createHmac("sha256", process.env["SLOT_TOKEN_SECRET"]!).update(body).digest("base64url");
    return `${Buffer.from(body).toString("base64url")}.${signature}`;
  };
  const staleTokens = (): Record<string, string> => ({
    current: mintSlotToken({ tenantId: clinic.tenantId, doctorId: clinic.doctorId, serviceId: clinic.serviceId, branchId: clinic.branchId, ...futureSlot(9) }, issuedLongAgo),
    "pre-4a": sevenField(issuedLongAgo.getTime() + SLOT_TOKEN_TTL_MS),
    "pre-4a, still unexpired": sevenField(Date.now() + 5 * 60_000),
  });
  const EXPECTED: Record<string, string> = { current: "EXPIRED_TOKEN", "pre-4a": "INVALID_TOKEN", "pre-4a, still unexpired": "INVALID_TOKEN" };

  const send = (who: keyof typeof tokens, method: string, path: string, body: unknown): Promise<Response> =>
    fetch(`${baseUrl}${path}`, {
      method,
      headers: { authorization: `Bearer ${tokens[who]}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  beforeAll(async () => {
    process.env["ATTACHMENTS_STORAGE_ROOT"] ??= process.cwd();
    clinic = await seedClinic();
    botUserId = await createTestUser();
    const botMembershipId = randomUUID();
    const receptionUserId = await createTestUser();
    const receptionMembershipId = randomUUID();
    booked = randomUUID();
    await withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) => {
      await tx.membership.create({ data: injected({ id: botMembershipId, userId: botUserId, role: "AI_AGENT", status: "ACTIVE" }) });
      await tx.membership.create({ data: injected({ id: receptionMembershipId, userId: receptionUserId, role: "RECEPTIONIST", status: "ACTIVE" }) });
      const slot = futureSlot(14);
      await tx.appointment.create({
        data: injected({ id: booked, branchId: clinic.branchId, patientId: clinic.patientId, doctorId: clinic.doctorId, serviceId: clinic.serviceId, scheduledStart: new Date(slot.startMs), scheduledEnd: new Date(slot.endMs), status: "BOOKED", source: "RECEPTION", createdBy: clinic.userId, updatedBy: clinic.userId }),
      });
    });
    tokens.reception = await issueAccessToken({ sub: receptionUserId, membershipId: receptionMembershipId, tenantId: clinic.tenantId, role: "RECEPTIONIST" });
    tokens.bot = await issueAccessToken({ sub: botUserId, membershipId: botMembershipId, tenantId: clinic.tenantId, role: "AI_AGENT" });

    app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: false });
    app.useGlobalPipes(refusingValidationPipe());
    await app.listen(0);
    baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await app?.close();
    await teardownClinic(clinic);
    await deleteTestUser(botUserId);
  });

  const routes = [
    { name: "reception books", who: "reception" as const, method: "POST", path: () => "/appointments", body: (slotToken: string) => ({ slotToken, patientId: clinic.patientId, source: "RECEPTION" }) },
    { name: "reception reschedules", who: "reception" as const, method: "PATCH", path: () => `/appointments/${booked}/reschedule`, body: (slotToken: string) => ({ slotToken }) },
    { name: "the bot books", who: "bot" as const, method: "POST", path: () => "/bot/appointments", body: (slotToken: string) => ({ slotToken, patientId: clinic.patientId, consentMessageId: "wamid.stale-page" }) },
  ];

  for (const route of routes) {
    for (const shape of Object.keys(EXPECTED)) {
      test(`${route.name} with a ${shape} token: 400 ${EXPECTED[shape]}, never 500, and nothing is written`, async () => {
        const before = await withTenant(clinic.tenantId, actorFor(clinic.userId), (tx) => tx.appointment.count());
        const response = await send(route.who, route.method, route.path(), route.body(staleTokens()[shape]!));
        expect(response.status).toBe(400);
        const { code } = (await response.json()) as { code: string };
        expect(code).toBe(EXPECTED[shape]);
        expect(await withTenant(clinic.tenantId, actorFor(clinic.userId), (tx) => tx.appointment.count())).toBe(before);
      });
    }
  }
});
