import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Module, ValidationPipe } from "@nestjs/common";
import { APP_INTERCEPTOR, NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { ActorContextInterceptor } from "../../src/common/actor-context.interceptor.ts";
import { AttachmentsController } from "../../src/modules/attachments/attachments.controller.ts";
import { AttachmentsSummaryController } from "../../src/modules/attachments/attachments-summary.controller.ts";
import { LocalFilesystemStorageProvider } from "../../src/modules/attachments/storage/local-filesystem.provider.ts";
import { STORAGE_PROVIDER } from "../../src/modules/attachments/storage/storage-provider.ts";
import { MAX_ATTACHMENT_BYTES } from "../../src/modules/attachments/storage/storage.config.ts";
import { issueAccessToken } from "../../src/modules/auth/jwt.ts";
import { prisma } from "../../src/prisma/client.ts";
import { injected } from "../../src/prisma/injected.ts";
import { withTenant } from "../../src/prisma/with-tenant.ts";
import {
  actorFor,
  createTestUser,
  seedClinic,
  teardownClinic,
  type ClinicFixture,
} from "./fixtures.ts";
import { generateFixturePhone } from "../fixture-phone.ts";
import { ThrottlingModule } from "../../src/common/throttling.module.ts";

/**
 * Attachments end to end — `PHASE-4.md` Q10, Q11, and the "Attachments" block of the Definition of
 * Done.
 *
 * Every box in that block that does not need an iPhone is proven here or in
 * `src/modules/attachments/domain/*.spec.ts`, and each test below names the one it closes.
 *
 * The storage root is a temporary directory created per run, so the suite writes nothing outside
 * itself and the assertions about *where bytes landed* are real rather than mocked. A fake provider
 * would make several of these tests vacuous: "no stored object is destroyed" means nothing against
 * an in-memory map that the test itself controls.
 */

let storageRoot = "";

@Module({
  // The upload route is rate-limited (4b), so its guard needs the throttler options in scope.
  imports: [ThrottlingModule],
  controllers: [AttachmentsController, AttachmentsSummaryController],
  providers: [
    { provide: APP_INTERCEPTOR, useClass: ActorContextInterceptor },
    {
      provide: STORAGE_PROVIDER,
      useFactory: () => new LocalFilesystemStorageProvider(storageRoot),
    },
  ],
})
class AttachmentsTestModule {}

/** Real leading bytes. A signature test that invents its own inputs proves nothing. */
const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);
const PDF_BYTES = Buffer.from("%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n");
/** A Windows PE header — the Definition of Done's "executable renamed `.pdf`". */
const EXE_BYTES = Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00, 0x04, 0x00]);

describe("attachments", () => {
  let app: NestExpressApplication;
  let baseUrl: string;
  let clinic: ClinicFixture;
  let otherClinic: ClinicFixture;

  let doctorToken: string;
  let receptionToken: string;
  let otherTenantDoctorToken: string;
  let visitId: string;

  /** Posts a multipart upload exactly as a browser would, declared type and filename included. */
  const upload = async (
    token: string,
    file: { bytes: Buffer; fileName: string; declaredType: string },
    fields: Record<string, string> = { category: "LAB" },
    patientId: string = clinic.patientId,
  ): Promise<{ status: number; body: any; text: string }> => {
    const form = new FormData();
    // `new Uint8Array(...)` rather than the Buffer directly: Buffer is typed over ArrayBufferLike,
    // which does not satisfy BlobPart. Same bytes, no copy of the contents' meaning.
    form.append(
      "file",
      new Blob([new Uint8Array(file.bytes)], { type: file.declaredType }),
      file.fileName,
    );
    for (const [key, value] of Object.entries(fields)) form.append(key, value);

    const response = await fetch(`${baseUrl}/patients/${patientId}/attachments`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: form,
    });
    const text = await response.text();
    return { status: response.status, body: text === "" ? null : JSON.parse(text), text };
  };

  const get = async (path: string, token: string): Promise<Response> =>
    fetch(`${baseUrl}${path}`, { headers: { authorization: `Bearer ${token}` } });

  /** A doctor in the same tenant with no appointment, visit or transfer grant for the patient. */
  const unrelatedDoctor = async (): Promise<{ token: string; doctorId: string }> => {
    const userId = await createTestUser();
    let membershipId = "";
    let doctorId = "";
    await withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) => {
      membershipId = randomUUID();
      await tx.membership.create({
        data: injected({ id: membershipId, userId, role: "DOCTOR", status: "ACTIVE" }),
      });
      doctorId = randomUUID();
      await tx.doctor.create({
        data: injected({
          id: doctorId,
          membershipId,
          specialty: "General",
          licenseNumber: `LIC-${doctorId.replace(/-/g, "").slice(0, 8)}`,
          title: "Dr.",
        }),
      });
    });
    const token = await issueAccessToken({
      sub: userId,
      membershipId,
      tenantId: clinic.tenantId,
      role: "DOCTOR",
    });
    return { token, doctorId };
  };

  beforeAll(async () => {
    storageRoot = await mkdtemp(join(tmpdir(), "clinic-os-attachments-it-"));

    clinic = await seedClinic();
    otherClinic = await seedClinic();

    // The patient is IN_CONSULTATION with this doctor, so the patient-level access rule passes and
    // the cross-doctor tests below are testing the rule rather than an incidental refusal.
    await withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) => {
      const appointmentId = randomUUID();
      const start = new Date();
      await tx.appointment.create({
        data: injected({
          id: appointmentId,
          patientId: clinic.patientId,
          doctorId: clinic.doctorId,
          serviceId: clinic.serviceId,
          scheduledStart: start,
          scheduledEnd: new Date(start.getTime() + 20 * 60_000),
          status: "IN_CONSULTATION",
          source: "RECEPTION",
          arrivedAt: start,
          waitingStartedAt: start,
          consultationStartedAt: start,
          createdBy: clinic.userId,
          updatedBy: clinic.userId,
        }),
      });

      visitId = randomUUID();
      await tx.visit.create({
        data: injected({
          id: visitId,
          patientId: clinic.patientId,
          doctorId: clinic.doctorId,
          appointmentId,
          complaint: "صداع",
          status: "COMPLETED",
          createdBy: clinic.userId,
        }),
      });
    });

    const receptionUserId = await createTestUser();
    let receptionMembershipId = "";
    await withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) => {
      receptionMembershipId = randomUUID();
      await tx.membership.create({
        data: injected({
          id: receptionMembershipId,
          userId: receptionUserId,
          role: "RECEPTIONIST",
          status: "ACTIVE",
        }),
      });
    });

    doctorToken = await issueAccessToken({
      sub: clinic.userId,
      membershipId: clinic.membershipId,
      tenantId: clinic.tenantId,
      role: "DOCTOR",
    });
    receptionToken = await issueAccessToken({
      sub: receptionUserId,
      membershipId: receptionMembershipId,
      tenantId: clinic.tenantId,
      role: "RECEPTIONIST",
    });
    otherTenantDoctorToken = await issueAccessToken({
      sub: otherClinic.userId,
      membershipId: otherClinic.membershipId,
      tenantId: otherClinic.tenantId,
      role: "DOCTOR",
    });

    app = await NestFactory.create<NestExpressApplication>(AttachmentsTestModule, { logger: false });
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        transformOptions: { enableImplicitConversion: true },
      }),
    );
    await app.init();
    await app.listen(0, "127.0.0.1");
    baseUrl = `http://127.0.0.1:${((app.getHttpServer() as Server).address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    if (app !== undefined) await app.close();
    await teardownClinic(clinic);
    await teardownClinic(otherClinic);
    await prisma.$disconnect();
    await rm(storageRoot, { recursive: true, force: true });
  });

  describe("upload", () => {
    test("a doctor can attach a PDF, and it comes back as metadata with no bytes", async () => {
      const result = await upload(doctorToken, {
        bytes: PDF_BYTES,
        fileName: "نتيجة التحليل.pdf",
        declaredType: "application/pdf",
      });

      expect(result.status).toBe(201);
      expect(result.body).toMatchObject({
        patientId: clinic.patientId,
        visitId: null,
        fileName: "نتيجة التحليل.pdf",
        mimeType: "application/pdf",
        sizeBytes: PDF_BYTES.byteLength,
        category: "LAB",
        uploadedByUserId: clinic.userId,
        archivedAt: null,
      });
      // The internal address is not part of the contract and must not leak into a response.
      expect(result.body).not.toHaveProperty("storageKey");
      expect(result.text).not.toContain(storageRoot);
    });

    test("it can be filed against one of that patient's visits", async () => {
      const result = await upload(
        doctorToken,
        { bytes: PNG_BYTES, fileName: "scan.png", declaredType: "image/png" },
        { category: "IMAGING", visitId, description: "Chest X-ray" },
      );

      expect(result.status).toBe(201);
      expect(result.body).toMatchObject({
        visitId,
        category: "IMAGING",
        description: "Chest X-ray",
        mimeType: "image/png",
      });
    });

    test("a visit belonging to a different patient is refused, not silently accepted", async () => {
      // A second patient who is genuinely this doctor's business -- otherwise the care-relationship
      // check refuses first and this test would pass for the wrong reason, never reaching the
      // mismatch it is named for.
      const strangerId = randomUUID();
      await withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) => {
        await tx.patient.create({
          data: injected({
            id: strangerId,
            fullNameAr: "مريض آخر",
            phoneE164: generateFixturePhone(),
            relationshipToContact: "SELF",
            status: "ACTIVE",
          }),
        });
        // A month ago, and COMPLETED. Two reasons: the doctor already has a live appointment at
        // `now` for the other patient, and `no_double_booking` is a database exclusion constraint
        // that would refuse an overlapping second one -- correctly. The relationship therefore
        // comes through the authored-visit door rather than presence.
        const past = new Date(Date.now() - 30 * 24 * 60 * 60_000);
        const pastAppointmentId = randomUUID();
        await tx.appointment.create({
          data: injected({
            id: pastAppointmentId,
            patientId: strangerId,
            doctorId: clinic.doctorId,
            serviceId: clinic.serviceId,
            scheduledStart: past,
            scheduledEnd: new Date(past.getTime() + 20 * 60_000),
            status: "COMPLETED",
            source: "RECEPTION",
            createdBy: clinic.userId,
            updatedBy: clinic.userId,
          }),
        });
        await tx.visit.create({
          data: injected({
            id: randomUUID(),
            patientId: strangerId,
            doctorId: clinic.doctorId,
            appointmentId: pastAppointmentId,
            complaint: "كشف سابق",
            status: "COMPLETED",
            createdBy: clinic.userId,
          }),
        });
      });

      const result = await upload(
        doctorToken,
        { bytes: PNG_BYTES, fileName: "misfiled.png", declaredType: "image/png" },
        { category: "LAB", visitId },
        strangerId,
      );

      expect(result.status).toBe(422);
      expect(result.body.code).toBe("VISIT_MISMATCH");
    });

    /** DoD: *"Type is decided by sniffing content, not the declared MIME type."* */
    test("an executable renamed .pdf and declared application/pdf is refused", async () => {
      const result = await upload(doctorToken, {
        bytes: EXE_BYTES,
        fileName: "lab-result.pdf",
        declaredType: "application/pdf",
      });

      expect(result.status).toBe(415);
      expect(result.body.code).toBe("UNSUPPORTED_TYPE");
    });

    test("a HEIC photograph is refused with a code that names it", async () => {
      const heic = Buffer.concat([
        Buffer.from([0x00, 0x00, 0x00, 0x18]),
        Buffer.from("ftypheic"),
        Buffer.alloc(16),
      ]);
      const result = await upload(doctorToken, {
        bytes: heic,
        fileName: "IMG_0001.HEIC",
        declaredType: "image/heic",
      });

      expect(result.status).toBe(415);
      expect(result.body.code).toBe("HEIC_NOT_CONVERTED");
    });

    test("an empty file is refused", async () => {
      const result = await upload(doctorToken, {
        bytes: Buffer.alloc(0),
        fileName: "empty.pdf",
        declaredType: "application/pdf",
      });

      expect(result.status).toBe(422);
      expect(result.body.code).toBe("EMPTY_FILE");
    });

    describe("the name and the media type must agree with the bytes", () => {
      test("a PDF named .jpg is refused, though both formats are accepted", async () => {
        const result = await upload(doctorToken, {
          bytes: PDF_BYTES,
          fileName: "x-ray.jpg",
          declaredType: "image/jpeg",
        });

        expect(result.status).toBe(415);
        expect(result.body.code).toBe("TYPE_MISMATCH");
        // **What disagreed is still asserted — as params rather than as prose.** The wire stopped
        // carrying a sentence on 2026-09-06, so the two halves the doctor needs are now named
        // fields. The client composes the Arabic from them; this checks the facts reached it.
        expect(result.body.params.claimed).toContain(".jpg");
        expect(result.body.params.detected).toContain("application/pdf");
      });

      test("a PNG named .pdf is refused", async () => {
        const result = await upload(doctorToken, {
          bytes: PNG_BYTES,
          fileName: "result.pdf",
          declaredType: "application/pdf",
        });
        expect(result.status).toBe(415);
        expect(result.body.code).toBe("TYPE_MISMATCH");
      });

      test("a contradicting media type is caught even when the name is silent", async () => {
        const result = await upload(doctorToken, {
          bytes: PDF_BYTES,
          fileName: "scan",
          declaredType: "image/png",
        });
        expect(result.status).toBe(415);
        expect(result.body.code).toBe("TYPE_MISMATCH");
      });

      test("octet-stream is not a contradiction — the browser simply did not know", async () => {
        // The case that would break a large share of real uploads if this were treated as a claim.
        const result = await upload(doctorToken, {
          bytes: PDF_BYTES,
          fileName: "referral.pdf",
          declaredType: "application/octet-stream",
        });
        expect(result.status).toBe(201);
      });

      test(".jpeg and .jpg are the same claim", async () => {
        const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32)]);
        const result = await upload(doctorToken, {
          bytes: jpeg,
          fileName: "photo.jpeg",
          declaredType: "image/jpg",
        });
        expect(result.status).toBe(201);
        expect(result.body.mimeType).toBe("image/jpeg");
      });

      test("nothing is stored when the claims disagree", async () => {
        const before = await withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) =>
          tx.attachment.count({ where: { patientId: clinic.patientId } }),
        );
        await upload(doctorToken, {
          bytes: PDF_BYTES,
          fileName: "mismatch.gif",
          declaredType: "image/gif",
        });
        const after = await withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) =>
          tx.attachment.count({ where: { patientId: clinic.patientId } }),
        );
        expect(after).toBe(before);
      });
    });

    /**
     * DoD: *"Over 10 MB is refused server-side, not only in the browser."*
     *
     * Both sides of the boundary, because "over 10 MB is refused" says nothing about where the
     * boundary actually sits — an off-by-one here would refuse a legitimate 10 MB scan, or admit an
     * 11 MB one, and either would pass a test that only pushed something enormous.
     */
    test("exactly at the limit is accepted", async () => {
      const exact = Buffer.concat([PDF_BYTES, Buffer.alloc(MAX_ATTACHMENT_BYTES - PDF_BYTES.byteLength)]);
      expect(exact.byteLength).toBe(MAX_ATTACHMENT_BYTES);

      const result = await upload(doctorToken, {
        bytes: exact,
        fileName: "exactly-ten-megabytes.pdf",
        declaredType: "application/pdf",
      });

      expect(result.status).toBe(201);
      expect(result.body.sizeBytes).toBe(MAX_ATTACHMENT_BYTES);
    });

    test("one byte over the limit is refused", async () => {
      const over = Buffer.concat([
        PDF_BYTES,
        Buffer.alloc(MAX_ATTACHMENT_BYTES - PDF_BYTES.byteLength + 1),
      ]);
      expect(over.byteLength).toBe(MAX_ATTACHMENT_BYTES + 1);

      const result = await upload(doctorToken, {
        bytes: over,
        fileName: "one-byte-too-far.pdf",
        declaredType: "application/pdf",
      });

      expect(result.status).toBe(413);
    });

    test("comfortably over the limit is refused, and nothing is stored", async () => {
      const oversized = Buffer.concat([PDF_BYTES, Buffer.alloc(MAX_ATTACHMENT_BYTES)]);
      expect(oversized.byteLength).toBeGreaterThan(MAX_ATTACHMENT_BYTES);

      const result = await upload(doctorToken, {
        bytes: oversized,
        fileName: "huge.pdf",
        declaredType: "application/pdf",
      });

      expect(result.status).toBe(413);
      const stored = await withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) =>
        tx.attachment.count({ where: { fileName: "huge.pdf" } }),
      );
      expect(stored).toBe(0);
    });

    test("a field the DTO does not declare is a 400, not a silently dropped value", async () => {
      const result = await upload(
        doctorToken,
        { bytes: PDF_BYTES, fileName: "x.pdf", declaredType: "application/pdf" },
        // `mimeType` is the field Q10 exists to stop us trusting. It must not be accepted at all.
        { category: "LAB", mimeType: "application/pdf" },
      );

      expect(result.status).toBe(400);
    });

    test("no file at all is a 400", async () => {
      const form = new FormData();
      form.append("category", "LAB");
      const response = await fetch(`${baseUrl}/patients/${clinic.patientId}/attachments`, {
        method: "POST",
        headers: { authorization: `Bearer ${doctorToken}` },
        body: form,
      });
      expect(response.status).toBe(400);
    });
  });

  describe("content is fetched through the API and nowhere else", () => {
    let attachmentId = "";
    let storageKey = "";

    beforeAll(async () => {
      const created = await upload(doctorToken, {
        bytes: PDF_BYTES,
        fileName: "تقرير.pdf",
        declaredType: "application/pdf",
      });
      attachmentId = created.body.id;
      const row = await withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) =>
        tx.attachment.findFirstOrThrow({
          where: { id: attachmentId },
          select: { storageKey: true },
        }),
      );
      storageKey = row.storageKey;
    });

    test("the bytes come back exactly", async () => {
      const response = await get(`/attachments/${attachmentId}/content`, doctorToken);
      expect(response.status).toBe(200);
      expect(Buffer.from(await response.arrayBuffer())).toEqual(PDF_BYTES);
    });

    /** DoD: *"Downloads carry `Content-Disposition: attachment`."* */
    test("the download is Content-Disposition: attachment, never inline", async () => {
      const response = await get(`/attachments/${attachmentId}/content`, doctorToken);
      const disposition = response.headers.get("content-disposition") ?? "";

      expect(disposition).toMatch(/^attachment;/);
      expect(disposition).not.toContain("inline");
      // RFC 6266 extended form, so the Arabic filename survives.
      expect(disposition).toContain(`filename*=UTF-8''${encodeURIComponent("تقرير.pdf")}`);
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    });

    /**
     * DoD: *"Content is fetched through the API under `visits.readContent`, never a public or
     * pre-signed URL. Proven by attempting the storage URL directly and being refused."*
     *
     * There is no storage URL to attempt, which is the point — so what is asserted is that no path
     * derived from the storage key serves the object, on the API that holds the only handle to it.
     */
    test("the storage key is not a URL on this API", async () => {
      for (const path of [
        `/${storageKey}`,
        `/attachments/${storageKey}`,
        `/files/${storageKey}`,
        `/uploads/${storageKey}`,
        `/static/${storageKey}`,
      ]) {
        const response = await fetch(`${baseUrl}${path}`, {
          headers: { authorization: `Bearer ${doctorToken}` },
        });
        expect(response.status).toBe(404);
        expect(await response.text()).not.toContain("%PDF");
      }
    });

    test("a traversal path cannot walk out of the storage root through the content route", async () => {
      // The route takes a UUID, so this is refused before anything filesystem-shaped is reached --
      // asserted so that a later change from ParseUUIDPipe to a looser param is caught here.
      const response = await get(`/attachments/..%2F..%2F..%2Fetc%2Fpasswd/content`, doctorToken);
      expect([400, 404]).toContain(response.status);
    });

    test("the object really is on disk under the configured root", async () => {
      const onDisk = await readFile(join(storageRoot, storageKey));
      expect(onDisk).toEqual(PDF_BYTES);
    });
  });

  describe("the clinical boundary", () => {
    let attachmentId = "";

    beforeAll(async () => {
      const created = await upload(doctorToken, {
        bytes: PDF_BYTES,
        fileName: "private.pdf",
        declaredType: "application/pdf",
      });
      attachmentId = created.body.id;
    });

    /** DoD: *"A reception token cannot fetch attachment content."* */
    test("reception is refused at the guard on every attachment route", async () => {
      const routes: { method: string; path: string }[] = [
        { method: "GET", path: `/patients/${clinic.patientId}/attachments` },
        { method: "GET", path: `/attachments/${attachmentId}/content` },
        { method: "POST", path: `/attachments/${attachmentId}/archive` },
      ];

      for (const route of routes) {
        const response = await fetch(`${baseUrl}${route.path}`, {
          method: route.method,
          headers: { authorization: `Bearer ${receptionToken}` },
        });
        expect(response.status).toBe(403);
        // Refused before the handler ran, so nothing about the file is disclosed.
        expect(await response.text()).not.toContain("private.pdf");
      }
    });

    test("reception cannot upload either — the founder's ruling, with its cost recorded", async () => {
      const result = await upload(receptionToken, {
        bytes: PDF_BYTES,
        fileName: "walk-in-lab-result.pdf",
        declaredType: "application/pdf",
      });
      expect(result.status).toBe(403);
    });

    test("another tenant's attachment is 404, not 403", async () => {
      const response = await get(`/attachments/${attachmentId}/content`, otherTenantDoctorToken);
      // 403 would confirm the record exists (CLAUDE.md).
      expect(response.status).toBe(404);
    });

    test("another tenant's patient is 404 on the list", async () => {
      const response = await get(
        `/patients/${clinic.patientId}/attachments`,
        otherTenantDoctorToken,
      );
      expect(response.status).toBe(404);
    });

    /**
     * The check `own-capability-enforcement.ts` demanded of anything consuming `visits.write`.
     *
     * `PermissionGuard` admits any doctor, because DOCTOR is FULL for that capability. Without the
     * service-level check this passes with 201 and a colleague's patient acquires a document.
     */
    test("a doctor with no relationship to the patient cannot upload onto their record", async () => {
      const { token } = await unrelatedDoctor();

      const result = await upload(token, {
        bytes: PDF_BYTES,
        fileName: "not-my-patient.pdf",
        declaredType: "application/pdf",
      });

      expect(result.status).toBe(403);
      expect(result.body.code).toBe("NOT_PERMITTED");
    });

    test("a doctor who authored a visit for the patient can still file a late lab result", async () => {
      // The case presence alone would break: the consultation is over, the patient has gone home,
      // and the result arrives days later. `hasCareRelationship`'s second door is what allows it.
      const { token, doctorId } = await unrelatedDoctor();
      await withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) => {
        const appointmentId = randomUUID();
        const past = new Date(Date.now() - 7 * 24 * 60 * 60_000);
        await tx.appointment.create({
          data: injected({
            id: appointmentId,
            patientId: clinic.patientId,
            doctorId,
            serviceId: clinic.serviceId,
            scheduledStart: past,
            scheduledEnd: new Date(past.getTime() + 20 * 60_000),
            // COMPLETED, so the patient is emphatically not present.
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
            doctorId,
            appointmentId,
            complaint: "متابعة",
            status: "COMPLETED",
            createdBy: clinic.userId,
          }),
        });
      });

      const result = await upload(token, {
        bytes: PDF_BYTES,
        fileName: "late-lab-result.pdf",
        declaredType: "application/pdf",
      });

      expect(result.status).toBe(201);
    });

    test("a doctor with no relationship to the patient sees only what they filed themselves", async () => {
      // They are a doctor, so the guard admits them; the service is what narrows the result.
      const { token: strangerToken } = await unrelatedDoctor();

      const list = await get(`/patients/${clinic.patientId}/attachments`, strangerToken);
      expect(list.status).toBe(200);
      expect(await list.json()).toEqual([]);

      const content = await get(`/attachments/${attachmentId}/content`, strangerToken);
      expect(content.status).toBe(403);
    });
  });

  describe("archiving", () => {
    /** DoD: *"Archiving sets `archived_at`; no row and no stored object is destroyed."* */
    test("sets archived_at, and leaves both the row and the bytes in place", async () => {
      const created = await upload(doctorToken, {
        bytes: PNG_BYTES,
        fileName: "mistake.png",
        declaredType: "image/png",
      });
      const attachmentId = created.body.id;

      const before = await withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) =>
        tx.attachment.findFirstOrThrow({
          where: { id: attachmentId },
          select: { storageKey: true, sizeBytes: true },
        }),
      );
      const sizeOnDiskBefore = (await stat(join(storageRoot, before.storageKey))).size;

      const response = await fetch(`${baseUrl}/attachments/${attachmentId}/archive`, {
        method: "POST",
        headers: { authorization: `Bearer ${doctorToken}` },
      });
      expect(response.status).toBe(201);
      expect(((await response.json()) as { archivedAt: string | null }).archivedAt).not.toBeNull();

      // The row survives, with every column it had.
      const after = await withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) =>
        tx.attachment.findFirstOrThrow({
          where: { id: attachmentId },
          select: { storageKey: true, sizeBytes: true, archivedAt: true, fileName: true },
        }),
      );
      expect(after.archivedAt).not.toBeNull();
      expect(after.storageKey).toBe(before.storageKey);
      expect(after.fileName).toBe("mistake.png");

      // And so does the stored object, byte for byte.
      expect((await stat(join(storageRoot, before.storageKey))).size).toBe(sizeOnDiskBefore);
      expect(await readFile(join(storageRoot, before.storageKey))).toEqual(PNG_BYTES);

      // Still downloadable — archived is not deleted.
      const content = await get(`/attachments/${attachmentId}/content`, doctorToken);
      expect(content.status).toBe(200);
    });

    test("archiving twice does not move the timestamp", async () => {
      const created = await upload(doctorToken, {
        bytes: PNG_BYTES,
        fileName: "twice.png",
        declaredType: "image/png",
      });
      const attachmentId = created.body.id;

      const first = await fetch(`${baseUrl}/attachments/${attachmentId}/archive`, {
        method: "POST",
        headers: { authorization: `Bearer ${doctorToken}` },
      });
      const firstAt = ((await first.json()) as { archivedAt: string }).archivedAt;

      const second = await fetch(`${baseUrl}/attachments/${attachmentId}/archive`, {
        method: "POST",
        headers: { authorization: `Bearer ${doctorToken}` },
      });
      expect(((await second.json()) as { archivedAt: string }).archivedAt).toBe(firstAt);
    });

    test("an archived attachment is still listed, marked rather than hidden", async () => {
      const list = await get(`/patients/${clinic.patientId}/attachments`, doctorToken);
      const rows = (await list.json()) as { fileName: string; archivedAt: string | null }[];

      const archived = rows.find((row) => row.fileName === "mistake.png");
      expect(archived).toBeDefined();
      expect(archived?.archivedAt).not.toBeNull();
    });
  });

  describe("the list", () => {
    test("returns metadata and never bytes or a storage key", async () => {
      const response = await get(`/patients/${clinic.patientId}/attachments`, doctorToken);
      expect(response.status).toBe(200);

      const text = await response.text();
      expect(text).not.toContain("storageKey");
      expect(text).not.toContain(storageRoot);
      expect(text).not.toContain("%PDF");

      const rows = JSON.parse(text);
      expect(rows.length).toBeGreaterThan(0);
      expect(rows[0]).toHaveProperty("fileName");
      expect(rows[0]).toHaveProperty("mimeType");
      expect(rows[0]).toHaveProperty("sizeBytes");
    });

    test("a patient that does not exist is 404", async () => {
      const response = await get(`/patients/${randomUUID()}/attachments`, doctorToken);
      expect(response.status).toBe(404);
    });
  });

  /**
   * Reception sees **which** documents exist, never what they contain — ruled 2026-09-05.
   *
   * The operational need is "the X-ray is already on file, don't ask him to bring it again". The
   * boundary is the filename: `أشعة_الركبة_اليمنى.pdf` names the condition, and that is §8's line.
   */
  describe("the reception-facing summary", () => {
    test("reception gets counts, categories, sizes and dates", async () => {
      const response = await get(`/patients/${clinic.patientId}/attachment-summary`, receptionToken);
      expect(response.status).toBe(200);

      const summary = (await response.json()) as {
        total: number;
        items: { category: string; sizeBytes: number; createdAt: string }[];
      };

      expect(summary.total).toBeGreaterThan(0);
      expect(summary.items).toHaveLength(summary.total);
      for (const item of summary.items) {
        expect(typeof item.category).toBe("string");
        expect(typeof item.sizeBytes).toBe("number");
        expect(typeof item.createdAt).toBe("string");
      }
    });

    /** The assertion the whole endpoint exists to satisfy. */
    test("the payload contains no filename — checked as raw text, against real uploaded names", async () => {
      const text = await (
        await get(`/patients/${clinic.patientId}/attachment-summary`, receptionToken)
      ).text();

      // Every filename this suite has uploaded against this patient. A nested object would pass a
      // key check and fail this one, which is the failure being guarded against.
      for (const fileName of [
        "نتيجة التحليل.pdf",
        "scan.png",
        "تقرير.pdf",
        "private.pdf",
        "mistake.png",
        "twice.png",
        "referral.pdf",
        "photo.jpeg",
        "exactly-ten-megabytes.pdf",
      ]) {
        expect(text).not.toContain(fileName);
      }
      // And nothing that could become a handle or a hint.
      expect(text).not.toContain("storageKey");
      expect(text).not.toContain("fileName");
      expect(text).not.toContain("mimeType");
      expect(text).not.toContain("description");
      expect(text).not.toContain("uploadedByUserId");
    });

    test("there is no id, so reception is handed nothing to try against the content route", async () => {
      const summary = (await (
        await get(`/patients/${clinic.patientId}/attachment-summary`, receptionToken)
      ).json()) as { items: Record<string, unknown>[] };

      for (const item of summary.items) {
        expect(Object.keys(item).sort()).toEqual(["category", "createdAt", "sizeBytes"]);
      }
    });

    test("archived attachments are not counted — the question is 'must he bring it again'", async () => {
      const before = (await (
        await get(`/patients/${clinic.patientId}/attachment-summary`, receptionToken)
      ).json()) as { total: number };

      const created = await upload(doctorToken, {
        bytes: PDF_BYTES,
        fileName: "to-be-archived.pdf",
        declaredType: "application/pdf",
      });
      expect(created.status).toBe(201);

      const afterUpload = (await (
        await get(`/patients/${clinic.patientId}/attachment-summary`, receptionToken)
      ).json()) as { total: number };
      expect(afterUpload.total).toBe(before.total + 1);

      await fetch(`${baseUrl}/attachments/${created.body.id}/archive`, {
        method: "POST",
        headers: { authorization: `Bearer ${doctorToken}` },
      });

      const afterArchive = (await (
        await get(`/patients/${clinic.patientId}/attachment-summary`, receptionToken)
      ).json()) as { total: number };
      // Back to where it was: an archived document is not on file for reception's purposes, while
      // the doctor's own list still shows it, marked.
      expect(afterArchive.total).toBe(before.total);
    });

    test("a doctor may read it too — visits.readIndex is FULL for both", async () => {
      expect(
        (await get(`/patients/${clinic.patientId}/attachment-summary`, doctorToken)).status,
      ).toBe(200);
    });

    test("another tenant's patient is 404, not an empty summary", async () => {
      // An empty summary would be a different wrong answer: it asserts something about a patient
      // the caller cannot see.
      const response = await get(
        `/patients/${clinic.patientId}/attachment-summary`,
        otherTenantDoctorToken,
      );
      expect(response.status).toBe(404);
    });

    test("a patient that does not exist is 404", async () => {
      expect(
        (await get(`/patients/${randomUUID()}/attachment-summary`, receptionToken)).status,
      ).toBe(404);
    });
  });
});
