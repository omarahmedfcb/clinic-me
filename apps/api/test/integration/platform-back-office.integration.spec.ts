import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Module } from "@nestjs/common";
import { APP_INTERCEPTOR, NestFactory } from "@nestjs/core";
import { ThrottlerModule } from "@nestjs/throttler";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { ActorContextInterceptor } from "../../src/common/actor-context.interceptor.ts";
import { refusingValidationPipe } from "../../src/common/validation-pipe.ts";
import { LocalFilesystemStorageProvider } from "../../src/modules/attachments/storage/local-filesystem.provider.ts";
import { STORAGE_PROVIDER } from "../../src/modules/attachments/storage/storage-provider.ts";
import { hashPassword } from "../../src/modules/auth/password.ts";
import { PlatformClientFileController } from "../../src/modules/platform/platform-client-file.controller.ts";
import { PlatformClinicsController } from "../../src/modules/platform/platform-clinics.controller.ts";
import { PlatformOperatorsController } from "../../src/modules/platform/platform-operators.controller.ts";
import { PlatformController } from "../../src/modules/platform/platform.controller.ts";
import { daysUntil, RENEWAL_REMINDER_DAYS, renewalIsDue } from "../../src/modules/platform/platform-client-file.ts";
import { issuePlatformToken } from "../../src/modules/platform/platform-token.ts";
import { totpCode } from "../../src/modules/platform/totp.ts";
import { injected } from "../../src/prisma/injected.ts";
import { prisma } from "../../src/prisma/client.ts";
import { withPlatformActor, withTenant } from "../../src/prisma/with-tenant.ts";
import {
  actorFor,
  createTestUser,
  FIXTURE_TOTP_SECRET,
  makeOperator,
  seedClinic,
  teardownClinic,
  type ClinicFixture,
} from "./fixtures.ts";

/**
 * The platform back office — the founder's review of #113, 2026-09-15.
 *
 * Two of these tests are the guards for the bug he reported, and they are the reason the file
 * exists at all: creating a clinic with a local Egyptian number failed, and the failure reached him
 * as "a system error occurred". The number was never the fault. The fault was that a DTO rejection
 * carries no refusal code, so the console's client mapped it to `INTERNAL` — its generic apology —
 * for what was a typing mistake in a different field.
 */

const OPERATOR_PASSWORD = "operator-only-not-a-real-password";
const SENTINEL = "SENTINEL-DIAGNOSIS-the-back-office-must-never-carry-this";
const STORAGE_ROOT = mkdtempSync(path.join(tmpdir(), "back-office-"));

@Module({
  imports: [ThrottlerModule.forRoot([{ name: "default", ttl: 60_000, limit: 1_000 }])],
  controllers: [
    PlatformController,
    PlatformClinicsController,
    PlatformOperatorsController,
    PlatformClientFileController,
  ],
  providers: [
    { provide: APP_INTERCEPTOR, useClass: ActorContextInterceptor },
    { provide: STORAGE_PROVIDER, useFactory: () => new LocalFilesystemStorageProvider(STORAGE_ROOT) },
  ],
})
class BackOfficeModule {}

/** A real, minimal PDF. The service checks the bytes as well as the declared type. */
const PDF_BYTES = Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n", "utf8");

/** Held as a constant so the Arabic filename is written once, by the editor. */
const CONTRACT_FILENAME = "عقد الاشتراك.pdf";

const rand = (): string => Math.floor(Math.random() * 10_000_000).toString().padStart(7, "0");

describe("the platform back office", () => {
  let app: NestExpressApplication;
  let baseUrl = "";
  let clinic: ClinicFixture;
  let ownerId = "";
  let ownerToken = "";
  let supportId = "";
  let supportToken = "";
  let tenantId = "";

  const call = async (
    method: string,
    routePath: string,
    token?: string,
    body?: unknown,
  ): Promise<{ status: number; text: string }> => {
    const response = await fetch(`${baseUrl}${routePath}`, {
      method,
      headers: {
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, text: await response.text() };
  };

  const newClinicBody = (over: Record<string, string> = {}): Record<string, string> => ({
    name: "عيادة المكتب الخلفي",
    slug: `back-office-${rand().slice(0, 6)}`,
    timezone: "Africa/Cairo",
    country: "EG",
    currency: "EGP",
    address: "شارع الاختبار",
    phone: `0129${rand()}`,
    adminFullName: "مديرة العيادة",
    adminPhone: `0111${rand()}`,
    ...over,
  });

  beforeAll(async () => {
    clinic = await seedClinic();

    // Real clinical content, so "the back office carried none" is a finding rather than a vacuum.
    await withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) => {
      const start = new Date(Date.now() - 48 * 60 * 60_000);
      const appointmentId = randomUUID();
      await tx.appointment.create({
        data: injected({
          id: appointmentId,
          patientId: clinic.patientId,
          doctorId: clinic.doctorId,
          serviceId: clinic.serviceId,
          scheduledStart: start,
          scheduledEnd: new Date(start.getTime() + 20 * 60_000),
          status: "COMPLETED",
          source: "RECEPTION",
          createdBy: clinic.userId,
          updatedBy: clinic.userId,
        }),
      });
      await tx.visit.create({
        data: injected({
          id: randomUUID(),
          patientId: clinic.patientId,
          doctorId: clinic.doctorId,
          appointmentId,
          diagnosis: SENTINEL,
          status: "COMPLETED",
          createdBy: clinic.userId,
        }),
      });
    });

    ownerId = await createTestUser();
    await makeOperator(ownerId, {
      platformRole: "OWNER",
      passwordHash: await hashPassword(OPERATOR_PASSWORD),
    });
    ownerToken = await issuePlatformToken(ownerId, "full");

    supportId = await createTestUser();
    await makeOperator(supportId, { platformRole: "SUPPORT" });
    supportToken = await issuePlatformToken(supportId, "full");

    app = await NestFactory.create<NestExpressApplication>(BackOfficeModule, { logger: false });
    // The production pipe, not a lookalike: its exceptionFactory is what turns a DTO rejection into
    // a refusal code, and a test module with a plain one would assert a shape the app never sends.
    app.useGlobalPipes(refusingValidationPipe());
    await app.listen(0, "127.0.0.1");
    baseUrl = `http://127.0.0.1:${((app.getHttpServer() as Server).address() as AddressInfo).port}`;

    const created = await call("POST", "/platform/clinics", ownerToken, newClinicBody());
    tenantId = (JSON.parse(created.text) as { tenantId: string }).tenantId;
  });

  afterAll(async () => {
    await app?.close();
    await teardownClinic(clinic);
    await prisma.$disconnect();
  });

  /**
   * **The founder's bug, in the two halves it actually had.**
   *
   * He reported that a local Egyptian number produced a 500. It does not, and never did — the first
   * test below is the proof, asserted on the stored E.164 rather than on a status code, so that
   * hard-coding the parser to another country fails it.
   *
   * The second is the defect. `ValidationPipe` rejects with `{ message: [...], error: "Bad Request" }`
   * and no `code`; `platform-api.ts` maps a body with no code to `INTERNAL`; the console renders
   * "حدث خطأ في النظام. لم يُنفَّذ الإجراء" — a system-error apology for a mistyped short name.
   */
  describe("creating a clinic: what the founder hit", () => {
    test("a local Egyptian number is stored as +20 E.164, in both fields", async () => {
      const localPhone = `0129${rand()}`;
      const localAdmin = `0122${rand()}`;

      const response = await call(
        "POST",
        "/platform/clinics",
        ownerToken,
        newClinicBody({ phone: localPhone, adminPhone: localAdmin }),
      );
      expect(response.status).toBe(201);

      const body = JSON.parse(response.text) as { tenantId: string; adminUserId: string };
      const stored = await withPlatformActor(actorFor(ownerId), async (tx) => ({
        clinic: await tx.tenant.findFirstOrThrow({ where: { id: body.tenantId }, select: { phone: true } }),
        admin: await tx.user.findFirstOrThrow({ where: { id: body.adminUserId }, select: { phoneE164: true } }),
      }));

      // The stored value, not the status. A test that asserted 201 passed with the parser pinned to
      // the wrong country, because `05…` is valid in both EG and SA — which is how the country
      // column's first guard turned out to be vacuous on 2026-09-14.
      expect({ clinic: stored.clinic.phone, admin: stored.admin.phoneE164 }).toEqual({
        clinic: `+20${localPhone.slice(1)}`,
        admin: `+20${localAdmin.slice(1)}`,
      });
    });

    test("every way of mistyping the form answers with a refusal code naming the field", async () => {
      const cases: { label: string; field: string; body: Record<string, string> }[] = [
        { label: "a short name with a space", field: "slug", body: newClinicBody({ slug: "nile clinic" }) },
        { label: "a short name in capitals", field: "slug", body: newClinicBody({ slug: "NileClinic" }) },
        { label: "a short name in Arabic", field: "slug", body: newClinicBody({ slug: "عيادة-النيل" }) },
        { label: "a one-letter clinic name", field: "name", body: newClinicBody({ name: "ع" }) },
        { label: "an empty address", field: "address", body: newClinicBody({ address: "" }) },
        { label: "a one-letter admin name", field: "adminFullName", body: newClinicBody({ adminFullName: "م" }) },
      ];

      const answers: { label: string; status: number; code: string; field: string }[] = [];
      for (const { label, field, body } of cases) {
        const reply = await call("POST", "/platform/clinics", ownerToken, body);
        const parsed = JSON.parse(reply.text) as { code?: string; params?: { field?: string } };
        answers.push({
          label,
          status: reply.status,
          // `(none)` is the bug: a body with no code renders as the system-error apology.
          code: parsed.code ?? "(none)",
          field: parsed.params?.field ?? "(none)",
        });
      }

      expect(answers).toEqual(cases.map(({ label, field }) => ({ label, status: 400, code: "INVALID_FIELD", field })));
    });

    test("and a phone that is not a phone is INVALID_PHONE, not INVALID_FIELD", async () => {
      // One authority on what a phone is. The DTO's own length rule was removed so that a short
      // number reaches `normalisePhone` and gets the sentence about phone numbers.
      const refused = await call("POST", "/platform/clinics", ownerToken, newClinicBody({ adminPhone: "012" }));
      expect({ status: refused.status, code: (JSON.parse(refused.text) as { code: string }).code }).toEqual({
        status: 400,
        code: "INVALID_PHONE",
      });
    });
  });

  /** 2a — operator seats and the second factor. */
  describe("operators", () => {
    test("the OWNER can seat one, and a SUPPORT operator cannot", async () => {
      const refused = await call("POST", "/platform/operators", supportToken, {
        fullName: "زميل جديد",
        phone: `0155${rand()}`,
        operatorRole: "SALES",
      });
      expect({ status: refused.status, code: (JSON.parse(refused.text) as { code: string }).code }).toEqual({
        status: 422,
        code: "NOT_OPERATOR_OWNER",
      });

      const seated = await call("POST", "/platform/operators", ownerToken, {
        fullName: "زميل جديد",
        phone: `0155${rand()}`,
        operatorRole: "SALES",
      });
      expect(seated.status).toBe(201);
      expect((JSON.parse(seated.text) as { temporaryPassword: string }).temporaryPassword.length).toBeGreaterThan(8);
    });

    test("the directory names everyone and carries no secret", async () => {
      const listed = await call("GET", "/platform/operators", ownerToken);
      expect(listed.status).toBe(200);

      const { operators } = JSON.parse(listed.text) as {
        operators: { userId: string; platformRole: string; totpEnrolled: boolean }[];
      };
      expect(operators.length).toBeGreaterThanOrEqual(3);
      expect(operators.some((row) => row.userId === ownerId && row.platformRole === "OWNER")).toBe(true);

      // By return type, not by a `select` somebody could widen: the function cannot name these.
      expect(listed.text).not.toContain("totpSecret");
      expect(listed.text).not.toContain("passwordHash");
      expect(listed.text).not.toContain(FIXTURE_TOTP_SECRET);
    });

    /**
     * **The password alone opens nothing.** This is the property "2FA required for every operator"
     * means when it is enforced rather than configured.
     */
    test("a new operator must enrol before any route answers", async () => {
      const seated = await call("POST", "/platform/operators", ownerToken, {
        fullName: "زميل بلا مصادقة",
        phone: `0106${rand()}`,
        operatorRole: "FINANCE",
      });
      const fresh = JSON.parse(seated.text) as { userId: string };

      // Even a token minted as `full` is refused: the guard re-reads the authenticator, so an
      // account with none is shut out no matter what a token claims.
      const forged = await issuePlatformToken(fresh.userId, "full");
      expect((await call("GET", "/platform/me", forged)).status).toBe(401);

      // The enrolment door does open, with a pending token.
      const pending = await issuePlatformToken(fresh.userId, "pending");
      const enrolled = await call("POST", "/platform/totp/enrol", pending);
      expect(enrolled.status).toBe(200);

      const { secretBase32 } = JSON.parse(enrolled.text) as { secretBase32: string; otpauthUri: string };
      expect(JSON.parse(enrolled.text).otpauthUri).toContain("otpauth://totp/");

      // A wrong code is refused with a sentence about codes.
      const wrong = await call("POST", "/platform/totp/confirm", pending, { totpCode: "000000" });
      expect((JSON.parse(wrong.text) as { code: string }).code).toBe("TOTP_INVALID");

      const right = await call("POST", "/platform/totp/confirm", pending, {
        totpCode: totpCode(secretBase32, Math.floor(Date.now() / 1000)),
      });
      expect(right.status).toBe(200);
      expect((await call("GET", "/platform/me", (JSON.parse(right.text) as { accessToken: string }).accessToken)).status).toBe(200);
    });

    test("an enrolled account cannot be re-enrolled, only reset by the OWNER", async () => {
      const pending = await issuePlatformToken(ownerId, "pending");
      const again = await call("POST", "/platform/totp/enrol", pending);
      expect((JSON.parse(again.text) as { code: string }).code).toBe("TOTP_ALREADY_ENROLLED");

      // A reason is required from 2026-09-16 — supplied here so the refusal under test is the seat
      // check and not the DTO, which would pass for the wrong reason.
      const bySupport = await call("POST", `/platform/operators/${ownerId}/totp/reset`, supportToken, {
        reason: "not my call to make",
      });
      expect((JSON.parse(bySupport.text) as { code: string }).code).toBe("NOT_OPERATOR_OWNER");
    });

    test("the last OWNER cannot be demoted, and nobody changes their own seat", async () => {
      const self = await call("POST", `/platform/operators/${ownerId}/role`, ownerToken, { operatorRole: "SALES" });
      expect((JSON.parse(self.text) as { code: string }).code).toBe("SELF_ROLE_CHANGE");
    });
  });

  /** 2b — the client file. */
  describe("the client file", () => {
    test("saves, reads back, and leaves untouched fields alone", async () => {
      const first = await call("POST", `/platform/clinics/${tenantId}/file`, ownerToken, {
        agreedPlan: "خطة الطبيبين",
        agreedMonthlyMinor: 240_000,
        discountPercent: 10,
        accountStatus: "ACTIVE",
        renewalOn: "2027-01-31",
        notes: "تم الاتفاق في اجتماع سبتمبر.",
        salesOwnerUserId: ownerId,
      });
      expect(first.status).toBe(200);

      // A second save naming one field must not blank the rest — the failure a whole-object PUT has.
      expect((await call("POST", `/platform/clinics/${tenantId}/file`, ownerToken, { discountPercent: 15 })).status).toBe(200);

      const read = JSON.parse((await call("GET", `/platform/clinics/${tenantId}/file`, ownerToken)).text) as {
        agreedPlan: string;
        agreedMonthlyMinor: number;
        discountPercent: number;
        accountStatus: string;
        renewalOn: string;
        salesOwnerName: string;
      };
      expect(read).toMatchObject({
        agreedPlan: "خطة الطبيبين",
        agreedMonthlyMinor: 240_000,
        discountPercent: 15,
        accountStatus: "ACTIVE",
        renewalOn: "2027-01-31",
      });
      expect(read.salesOwnerName).not.toBe("");
    });

    test("a discount outside 0-100 is refused by the service and by the database", async () => {
      const refused = await call("POST", `/platform/clinics/${tenantId}/file`, ownerToken, { discountPercent: 140 });
      expect(refused.status).toBe(400);

      // And the CHECK refuses it even when the service is bypassed — D5's reasoning, applied here.
      const raw = withPlatformActor(actorFor(ownerId), (tx) =>
        tx.$executeRaw`UPDATE platform_clinic_files SET discount_percent = 140 WHERE tenant_id = ${tenantId}::uuid`,
      );
      await expect(raw).rejects.toThrow(/platform_clinic_files_amounts_sane/i);
    });

    test("contacts are added, listed and removed", async () => {
      const added = await call("POST", `/platform/clinics/${tenantId}/contacts`, ownerToken, {
        contactName: "أخو المالك الذي يسدّد الفواتير",
        contactRole: "المسؤول المالي",
        contactPhone: `0100${rand()}`,
      });
      expect(added.status).toBe(201);
      const { id } = JSON.parse(added.text) as { id: string };

      const withContact = JSON.parse((await call("GET", `/platform/clinics/${tenantId}/file`, ownerToken)).text) as {
        contacts: { id: string; phoneE164: string }[];
      };
      const stored = withContact.contacts.find((row) => row.id === id);
      // The clinic's own country as the hint, §18b — a local number is stored as E.164 here too.
      expect(stored?.phoneE164?.startsWith("+20")).toBe(true);

      expect((await call("POST", `/platform/clinics/${tenantId}/contacts/${id}/remove`, ownerToken)).status).toBe(200);
      const after = JSON.parse((await call("GET", `/platform/clinics/${tenantId}/file`, ownerToken)).text) as {
        contacts: { id: string }[];
      };
      expect(after.contacts.some((row) => row.id === id)).toBe(false);
    });

    test("a contact nobody can reach is refused", async () => {
      const refused = await call("POST", `/platform/clinics/${tenantId}/contacts`, ownerToken, {
        contactName: "بلا وسيلة اتصال",
      });
      expect((JSON.parse(refused.text) as { code: string }).code).toBe("INVALID_PHONE");
    });

    test("a contract PDF uploads, comes back as bytes, and its term is checked", async () => {
      const upload = async (startsOn: string, endsOn: string, bytes: Buffer, type: string) => {
        const form = new FormData();
        form.append("file", new Blob([new Uint8Array(bytes)], { type }), CONTRACT_FILENAME);
        form.append("startsOn", startsOn);
        form.append("endsOn", endsOn);
        const response = await fetch(`${baseUrl}/platform/clinics/${tenantId}/contracts`, {
          method: "POST",
          headers: { authorization: `Bearer ${ownerToken}` },
          body: form,
        });
        return { status: response.status, text: await response.text() };
      };

      const backwards = await upload("2027-01-01", "2026-01-01", PDF_BYTES, "application/pdf");
      expect((JSON.parse(backwards.text) as { code: string }).code).toBe("INVALID_DATE_RANGE");

      const notPdf = await upload("2026-01-01", "2027-01-01", Buffer.from("MZ not a pdf"), "application/pdf");
      expect((JSON.parse(notPdf.text) as { code: string }).code).toBe("UNSUPPORTED_TYPE");

      const good = await upload("2026-01-01", "2027-01-01", PDF_BYTES, "application/pdf");
      expect(good.status).toBe(201);
      const { id } = JSON.parse(good.text) as { id: string };

      const content = await fetch(`${baseUrl}/platform/clinics/${tenantId}/contracts/${id}/content`, {
        headers: { authorization: `Bearer ${ownerToken}` },
      });
      expect(content.status).toBe(200);
      expect(content.headers.get("content-type")).toBe("application/pdf");
      expect(Buffer.from(await content.arrayBuffer()).equals(PDF_BYTES)).toBe(true);

      // The Arabic filename survives. Multer defaults to latin1, and a contract stored as mojibake
      // loses the original — the failure `attachments.integration.spec.ts` was written for.
      const listed = JSON.parse((await call("GET", `/platform/clinics/${tenantId}/file`, ownerToken)).text) as {
        contracts: { id: string; fileName: string }[];
      };
      expect(listed.contracts.find((row) => row.id === id)?.fileName).toBe(CONTRACT_FILENAME);
    });
  });

  /** 2c — the account's commercial state, and the fourteen-day warning. */
  describe("subscription state and the renewal reminder", () => {
    test("the countdown is arithmetic on a date it is given, never on the clock", () => {
      const today = new Date("2026-09-15T00:00:00.000Z");
      expect(daysUntil(new Date("2026-09-29T00:00:00.000Z"), today)).toBe(RENEWAL_REMINDER_DAYS);
      expect(renewalIsDue(RENEWAL_REMINDER_DAYS)).toBe(true);
      expect(renewalIsDue(RENEWAL_REMINDER_DAYS + 1)).toBe(false);
      // Already past still warns: a renewal nobody acted on is the case the reminder is for.
      expect(renewalIsDue(-3)).toBe(true);
      expect(renewalIsDue(null)).toBe(false);
    });

    test("the clinic list carries the account status and flags a renewal inside the window", async () => {
      const soon = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      await call("POST", `/platform/clinics/${tenantId}/file`, ownerToken, {
        accountStatus: "OVERDUE",
        renewalOn: soon,
      });

      const listed = JSON.parse((await call("GET", "/platform/clinics", ownerToken)).text) as {
        clinics: { tenantId: string; accountStatus: string; renewalDue: boolean; renewalInDays: number | null }[];
      };
      const row = listed.clinics.find((entry) => entry.tenantId === tenantId);
      expect({ status: row?.accountStatus, due: row?.renewalDue, days: row?.renewalInDays }).toEqual({
        status: "OVERDUE",
        due: true,
        days: 7,
      });

      // A clinic with no client file reads as a trial with no date, which is what it is.
      const untouched = listed.clinics.find((entry) => entry.tenantId === clinic.tenantId);
      expect({ status: untouched?.accountStatus, due: untouched?.renewalDue }).toEqual({
        status: "TRIAL",
        due: false,
      });
    });
  });

  /**
   * **The wall, in the direction this feature added.**
   *
   * The back office is the first set of tables where the *clinic* is the one who must see nothing.
   * Everything else in this schema protects a clinic from another clinic; these protect the vendor's
   * commercial file from the customer it is about.
   */
  describe("the clinic cannot read its own client file", () => {
    test("a clinic session sees zero rows in all three tables, and RLS is what says so", async () => {
      const counts = await withTenant(tenantId, actorFor(clinic.userId), async (tx) => ({
        files: await tx.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM platform_clinic_files`,
        contacts: await tx.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM platform_clinic_contacts`,
        contracts: await tx.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM platform_clinic_contracts`,
      }));
      expect({
        files: Number(counts.files[0]?.n),
        contacts: Number(counts.contacts[0]?.n),
        contracts: Number(counts.contracts[0]?.n),
      }).toEqual({ files: 0, contacts: 0, contracts: 0 });
    });

    test("and the rows really are there for an operator, so the test above is not vacuous", async () => {
      const files = await withPlatformActor(actorFor(ownerId), (tx) => tx.platformClinicFile.count());
      expect(files).toBeGreaterThan(0);
    });

    test("the clinic's own audit trail carries none of the commercial terms", async () => {
      // `audit_row_change()` stores `to_jsonb(NEW)`. Had the back-office tables used it, the agreed
      // discount and the sales notes would be on the clinic's audit screen. They are written with
      // `tenant_id = NULL` instead, which the D17 policy shows to no tenant session.
      const rows = await withTenant(tenantId, actorFor(clinic.userId), (tx) =>
        tx.auditLog.findMany({ select: { entityType: true, newState: true } }),
      );

      // Not vacuous: the clinic's trail has rows — it was created by the console and a contract was
      // filed against it — so "the terms are not in it" is a finding rather than an empty table.
      // Without this the assertion below passed with the trigger pointed at the clinic's own tenant,
      // simply because that run had written no client file yet.
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.some((row) => row.entityType === "platform_clinic_contracts")).toBe(true);

      const text = JSON.stringify(rows);
      for (const term of ["platform_clinic_files", "خطة الطبيبين", "تم الاتفاق في اجتماع سبتمبر", "discount_percent"]) {
        expect(text).not.toContain(term);
      }
    });

    test("no back-office write carries clinical content either", async () => {
      const file = await call("GET", `/platform/clinics/${tenantId}/file`, ownerToken);
      const clinics = await call("GET", "/platform/clinics", ownerToken);
      expect(file.text.includes(SENTINEL) || clinics.text.includes(SENTINEL)).toBe(false);
    });
  });

  /**
   * `OPERATOR_TOTP=off` — the review lever, and what it does and does not change.
   *
   * The second factor blocked a review on 2026-09-15: the seeded operator had a confirmed
   * authenticator, so the console asked for a code the reviewer could not produce and the enrolment
   * screen sat behind it. This is the escape, and the boot check in `totp-policy.ts` is what keeps
   * it out of production — asserted there, because a unit spec can construct a production
   * environment and an integration one cannot without refusing to start.
   */
  describe("the second factor can be turned off for development", () => {
    const original = process.env["OPERATOR_TOTP"];
    let ownerPhone = "";

    beforeAll(async () => {
      ownerPhone = (
        await withPlatformActor(actorFor(ownerId), (tx) =>
          tx.user.findFirstOrThrow({ where: { id: ownerId }, select: { phoneE164: true } }),
        )
      ).phoneE164;
    });

    afterEach(() => {
      if (original === undefined) delete process.env["OPERATOR_TOTP"];
      else process.env["OPERATOR_TOTP"] = original;
    });

    test("with it on, the password buys a pending token and nothing else", async () => {
      delete process.env["OPERATOR_TOTP"];
      const response = await call("POST", "/platform/login", undefined, {
        identifier: ownerPhone,
        password: OPERATOR_PASSWORD,
      });
      const body = JSON.parse(response.text) as Record<string, unknown>;
      expect({
        status: response.status,
        pending: typeof body["pendingToken"] === "string",
        access: "accessToken" in body,
        required: body["totpRequired"],
      }).toEqual({ status: 200, pending: true, access: false, required: true });
    });

    test("with it off, the same password opens the console directly", async () => {
      process.env["OPERATOR_TOTP"] = "off";
      const response = await call("POST", "/platform/login", undefined, {
        identifier: ownerPhone,
        password: OPERATOR_PASSWORD,
      });
      const body = JSON.parse(response.text) as { accessToken?: string; totpRequired?: boolean };
      expect({ status: response.status, required: body.totpRequired }).toEqual({ status: 200, required: false });

      // And the token it issued really opens the surface, rather than merely being returned.
      expect((await call("GET", "/platform/me", body.accessToken)).status).toBe(200);
    });

    test("and an operator with no authenticator at all is let in when it is off", async () => {
      // The case that matters for review: the seed enrols nobody, so this is the state the console
      // is actually reached in. With the flag on, the same account is refused every route.
      const fresh = await createTestUser();
      await withPlatformActor(actorFor(fresh), (tx) =>
        tx.user.update({
          where: { id: fresh },
          data: {
            isPlatformAdmin: true,
            platformRole: "SUPPORT",
            status: "ACTIVE",
            totpSecret: null,
            totpConfirmedAt: null,
          },
        }),
      );
      const token = await issuePlatformToken(fresh, "full");

      process.env["OPERATOR_TOTP"] = "off";
      expect((await call("GET", "/platform/me", token)).status).toBe(200);

      delete process.env["OPERATOR_TOTP"];
      expect((await call("GET", "/platform/me", token)).status).toBe(401);
    });
  });
});
