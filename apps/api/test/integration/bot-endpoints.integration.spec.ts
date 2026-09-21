import { randomUUID } from "node:crypto";
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
 * The bot's surface, and — mostly — what it is refused.
 *
 * `docs/WHATSAPP-BOT-CONTRACT.md` is a promise made to someone outside this repository, running
 * software we do not control against a real clinic's data. Each refusal below is one sentence of
 * that promise, asserted rather than described: clinical content, money, the patient book, another
 * clinic's rows, and any field beyond a name and a phone on the one thing the bot may create.
 *
 * The whole `AppModule` is mounted rather than a hand-assembled module, because half of what is
 * being tested is that routes the bot must NOT reach refuse it — and a module that omitted those
 * controllers would pass by not having them.
 */
describe("the WhatsApp bot's endpoints", () => {
  let app: NestExpressApplication;
  let baseUrl = "";
  let clinic: ClinicFixture;
  let otherClinic: ClinicFixture;
  let botToken = "";
  let botUserId = "";
  let householdPhone = "";
  const createdPatients: string[] = [];

  const call = (token: string, method: string, url: string, body?: unknown): Promise<Response> =>
    fetch(`${baseUrl}${url}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  beforeAll(async () => {
    process.env["ATTACHMENTS_STORAGE_ROOT"] ??= process.cwd();
    clinic = await seedClinic();
    otherClinic = await seedClinic();

    // The bot's identity: a user with an AI_AGENT membership in one clinic. Issuing and revoking
    // this from the clinic settings API is 2c; here it is created directly, because what is under
    // test is what the role may do, not how the credential is minted.
    botUserId = randomUUID();
    await prisma.user.create({
      data: {
        id: botUserId,
        phoneE164: generateFixturePhone(),
        passwordHash: "bot-has-no-password",
        fullName: "WhatsApp bot",
        status: "ACTIVE",
      },
    });
    const botMembershipId = await withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) => {
      const id = randomUUID();
      await tx.membership.create({
        data: injected({ id, userId: botUserId, role: "AI_AGENT", status: "ACTIVE" }),
      });
      return id;
    });
    botToken = await issueAccessToken({
      sub: botUserId,
      membershipId: botMembershipId,
      tenantId: clinic.tenantId,
      role: "AI_AGENT",
    });

    // A household: a mother and her child on one number, which is the case the lookup exists for.
    householdPhone = generateFixturePhone();
    await withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) => {
      const contact = await tx.contact.create({ data: injected({ id: randomUUID(), phoneE164: householdPhone }) });
      for (const [name, relationship] of [
        ["أم الأسرة", "SELF"],
        ["ابن الأسرة", "CHILD"],
      ] as const) {
        const id = randomUUID();
        createdPatients.push(id);
        await tx.patient.create({
          data: injected({
            id,
            contactId: contact.id,
            fullNameAr: name,
            phoneE164: householdPhone,
            relationshipToContact: relationship,
            status: "ACTIVE",
          }),
        });
      }
    });

    app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: false });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.listen(0);
    baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await app?.close();
    await teardownClinic(clinic);
    await teardownClinic(otherClinic);
    await prisma.user.delete({ where: { id: botUserId } }).catch(() => undefined);
    await prisma.$disconnect();
  });

  describe("finding a patient by phone", () => {
    test("returns every patient on the number, with relationship and nothing else", async () => {
      const response = await call(botToken, "GET", `/bot/patients?phone=${encodeURIComponent(householdPhone)}`);
      expect(response.status).toBe(200);

      const body = (await response.json()) as { patients: Record<string, unknown>[] };
      expect(body.patients).toHaveLength(2);
      expect(body.patients.map((patient) => patient["relationshipToContact"]).sort()).toEqual(["CHILD", "SELF"]);

      // The shape is the promise: four keys, and none of them clinical, financial or identifying
      // beyond the display name the patient gave the clinic themselves.
      for (const patient of body.patients) {
        expect(Object.keys(patient).sort()).toEqual([
          "displayName",
          "intakeIncomplete",
          "patientId",
          "relationshipToContact",
        ]);
      }
    });

    test("a number with nobody on it is an empty list, not a 404 that confirms nothing", async () => {
      const response = await call(botToken, "GET", "/bot/patients?phone=%2B201000000009");
      expect(response.status).toBe(200);
      expect(((await response.json()) as { patients: unknown[] }).patients).toEqual([]);
    });

    test("a partial number is refused: a prefix search would walk the book a digit at a time", async () => {
      expect((await call(botToken, "GET", "/bot/patients?phone=%2B2015")).status).toBe(400);
      expect((await call(botToken, "GET", "/bot/patients?phone=0100")).status).toBe(400);
    });

    test("another clinic's patient is not on this clinic's number", async () => {
      const strangerPhone = generateFixturePhone();
      await withTenant(otherClinic.tenantId, actorFor(otherClinic.userId), async (tx) => {
        const contact = await tx.contact.create({ data: injected({ id: randomUUID(), phoneE164: strangerPhone }) });
        await tx.patient.create({
          data: injected({
            id: randomUUID(),
            contactId: contact.id,
            fullNameAr: "مريضة عيادة أخرى",
            phoneE164: strangerPhone,
            relationshipToContact: "SELF",
            status: "ACTIVE",
          }),
        });
      });

      const response = await call(botToken, "GET", `/bot/patients?phone=${encodeURIComponent(strangerPhone)}`);
      expect(response.status).toBe(200);
      expect(((await response.json()) as { patients: unknown[] }).patients).toEqual([]);
    });
  });

  describe("creating a provisional patient", () => {
    test("a name and a phone is enough, and the record is marked as the bot's", async () => {
      const phone = generateFixturePhone();
      const response = await call(botToken, "POST", "/bot/patients", {
        fullNameAr: "مريض جديد من واتساب",
        phoneE164: phone,
      });
      expect(response.status).toBe(201);

      const created = (await response.json()) as { patientId: string; displayName: string };
      createdPatients.push(created.patientId);

      const row = await withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) =>
        tx.patient.findFirstOrThrow({
          where: { id: created.patientId },
          select: { createdVia: true, dateOfBirth: true, gender: true, nationality: true, relationshipToContact: true },
        }),
      );
      expect(row.createdVia).toBe("WHATSAPP_BOT");
      // Incomplete by construction, which is what puts it in front of reception.
      expect([row.dateOfBirth, row.gender, row.nationality]).toEqual([null, null, null]);
      expect(row.relationshipToContact).toBe("SELF");
    });

    test.each([
      ["dateOfBirth", { dateOfBirth: "1990-01-01" }],
      ["gender", { gender: "female" }],
      ["notes", { notes: "says she has diabetes" }],
      ["nationalId", { nationalId: "29001010123456" }],
      ["createdVia", { createdVia: "DESK" }],
      ["relationshipToContact", { relationshipToContact: "CHILD" }],
    ])("%s in the body is refused, not ignored", async (_field, extra) => {
      const response = await call(botToken, "POST", "/bot/patients", {
        fullNameAr: "مريض",
        phoneE164: generateFixturePhone(),
        ...extra,
      });
      expect(response.status).toBe(400);
    });

    test("the bot cannot edit an existing patient: there is no route for it", async () => {
      const target = createdPatients[0] ?? "";
      for (const [method, url] of [
        ["PATCH", `/patients/${target}`],
        ["PATCH", `/bot/patients/${target}`],
        ["POST", `/bot/patients/${target}`],
      ] as const) {
        const response = await call(botToken, method, url, { fullNameAr: "اسم مختلف" });
        expect([403, 404]).toContain(response.status);
      }
    });
  });

  describe("what the bot is refused", () => {
    test.each([
      ["the patient book", "GET", "/patients/recent"],
      ["patient search", "GET", "/patients?q=%D8%A3"],
      ["one patient's record", "GET", "/patients/00000000-0000-7000-8000-000000000000"],
      ["a visit's clinical content", "GET", "/appointments/00000000-0000-7000-8000-000000000000/visit"],
      ["payments", "GET", "/payments/overview"],
      ["financial reports", "GET", "/reports/payments?period=month&date=2026-09-01"],
      ["the audit log", "GET", "/audit-log?limit=1"],
      ["the staff list", "GET", "/staff"],
      ["the clinic's day", "GET", "/queue/today?date=2026-09-18"],
    ])("%s", async (_what, method, url) => {
      const response = await call(botToken, method, url);
      // 403 from the capability guard. Never 200, and never a 404 that would mean the route simply
      // is not there — the point is that the route exists and refuses this caller.
      expect(response.status).toBe(403);
    });

    test("a clinical payload never reaches the bot, whatever it asks for", async () => {
      const responses = await Promise.all(
        ["/patients/recent", "/payments/overview", "/audit-log?limit=1"].map(async (url) => {
          const response = await call(botToken, "GET", url);
          return response.text();
        }),
      );
      for (const body of responses) {
        expect(body).not.toMatch(/diagnos|prescription|invoice|تشخيص|روشتة/i);
      }
    });
  });

  describe("appointments", () => {
    test("another clinic's appointment is 404, never 403", async () => {
      const foreign = await withTenant(otherClinic.tenantId, actorFor(otherClinic.userId), async (tx) =>
        tx.appointment.findFirst({ select: { id: true } }),
      );
      const id = foreign?.id ?? "00000000-0000-7000-8000-000000000000";
      const response = await call(botToken, "GET", `/bot/appointments/${id}`);
      expect(response.status).toBe(404);
    });

    test("an unknown appointment is 404 with no detail about whether it exists", async () => {
      const response = await call(botToken, "GET", "/bot/appointments/00000000-0000-7000-8000-000000000000");
      expect(response.status).toBe(404);
      expect(await response.text()).not.toMatch(/tenant|clinic|exists/i);
    });
  });

  describe("consent", () => {
    test("is recorded against the patient, with the message as evidence", async () => {
      const patientId = createdPatients[0] ?? "";
      const response = await call(botToken, "POST", `/bot/patients/${patientId}/consent`, {
        purpose: "WHATSAPP_COMMS",
        granted: true,
        externalMessageId: "wamid.TEST123",
      });
      expect(response.status).toBe(201);

      const consent = await withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) =>
        tx.consent.findFirstOrThrow({ where: { patientId }, select: { purpose: true, granted: true, evidence: true } }),
      );
      expect(consent.purpose).toBe("WHATSAPP_COMMS");
      expect(consent.granted).toBe(true);
      expect(consent.evidence).toMatchObject({ channel: "whatsapp", externalMessageId: "wamid.TEST123" });
    });

    test("a booking with no message id to hang consent on is refused before it books", async () => {
      // Ruled 2026-09-18: a booking in chat is where consent is given, and consent with no evidence
      // is an assertion. The DTO refuses the body, so nothing is booked and nothing is sent later.
      const response = await call(botToken, "POST", "/bot/appointments", {
        slotToken: "not-a-real-token",
        patientId: createdPatients[0] ?? "",
      });
      expect(response.status).toBe(400);
      expect(await response.text()).toContain("consentMessageId");
    });

    test("a purpose the desk owns is refused", async () => {
      const response = await call(botToken, "POST", `/bot/patients/${createdPatients[0] ?? ""}/consent`, {
        purpose: "TREATMENT",
        granted: true,
      });
      expect(response.status).toBe(400);
    });
  });

  describe("every bot call is audited as the bot", () => {
    test("the lookup leaves a row naming AI_AGENT", async () => {
      await call(botToken, "POST", "/bot/patients", {
        fullNameAr: "مريضة للتدقيق",
        phoneE164: generateFixturePhone(),
      });

      const rows = await withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) =>
        tx.auditLog.findMany({ where: { actorUserId: botUserId }, select: { actorRole: true, entityType: true } }),
      );
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((row) => row.actorRole === "AI_AGENT")).toBe(true);
      expect(rows.some((row) => row.entityType === "patients")).toBe(true);
    });
  });
});
