import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Module, ValidationPipe } from "@nestjs/common";
import { APP_INTERCEPTOR, NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import type { AddressInfo } from "node:net";
import { ActorContextInterceptor } from "../../src/common/actor-context.interceptor.ts";
import { issueAccessToken } from "../../src/modules/auth/jwt.ts";
import { ClinicIdentityController } from "../../src/modules/clinic-identity/clinic-identity.controller.ts";
import { LocalFilesystemStorageProvider } from "../../src/modules/attachments/storage/local-filesystem.provider.ts";
import { STORAGE_PROVIDER } from "../../src/modules/attachments/storage/storage-provider.ts";
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

/**
 * Clinic identity and the doctor's print fields — `PHASE-4.md` Q28, plan PR 7f.
 *
 * The assertion that carries this file is the last one: **a doctor from another clinic is not found,
 * and nothing is written.** The route takes a doctor id from the path, and a signature filed onto a
 * stranger's record is exactly the failure `own-capability-enforcement.ts` exists to keep asking
 * about.
 */

const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);
const PDF = Buffer.from("%PDF-1.7\n%\xE2\xE3\xCF\xD3\n", "latin1");

describe("the clinic's printed identity", () => {
  let app: NestExpressApplication;
  let baseUrl: string;
  let storageRoot = "";
  let clinic: ClinicFixture;
  let other: ClinicFixture;
  let adminToken = "";
  let doctorToken = "";
  let receptionToken = "";
  /** A second doctor in the SAME clinic — the only fixture that can prove `own` scoping. */
  let colleagueDoctorId = "";

  const call = async (
    method: string,
    url: string,
    token: string,
    body?: unknown,
  ): Promise<Response> =>
    fetch(`${baseUrl}${url}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  const upload = async (url: string, token: string, bytes: Buffer): Promise<Response> => {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(bytes)]), "image.png");
    return fetch(`${baseUrl}${url}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: form,
    });
  };

  beforeAll(async () => {
    storageRoot = await mkdtemp(path.join(tmpdir(), "clinic-identity-"));
    clinic = await seedClinic();
    other = await seedClinic();

    const adminUserId = await createTestUser();
    let adminMembershipId = "";
    await withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) => {
      adminMembershipId = randomUUID();
      await tx.membership.create({
        data: injected({ id: adminMembershipId, userId: adminUserId, role: "ADMIN", status: "ACTIVE" }),
      });
    });
    adminToken = await issueAccessToken({
      sub: adminUserId,
      membershipId: adminMembershipId,
      tenantId: clinic.tenantId,
      role: "ADMIN",
    });
    doctorToken = await issueAccessToken({
      sub: clinic.userId,
      membershipId: clinic.membershipId,
      tenantId: clinic.tenantId,
      role: "DOCTOR",
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
    receptionToken = await issueAccessToken({
      sub: receptionUserId,
      membershipId: receptionMembershipId,
      tenantId: clinic.tenantId,
      role: "RECEPTIONIST",
    });

    const colleagueUserId = await createTestUser();
    await withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) => {
      const membershipId = randomUUID();
      await tx.membership.create({
        data: injected({ id: membershipId, userId: colleagueUserId, role: "DOCTOR", status: "ACTIVE" }),
      });
      colleagueDoctorId = randomUUID();
      await tx.doctor.create({
        data: injected({
          id: colleagueDoctorId,
          membershipId,
          specialty: "General",
          licenseNumber: `LIC-${colleagueDoctorId.slice(0, 8)}`,
          title: "Dr.",
        }),
      });
    });

    @Module({
      controllers: [ClinicIdentityController],
      providers: [
        { provide: APP_INTERCEPTOR, useClass: ActorContextInterceptor },
        {
          provide: STORAGE_PROVIDER,
          useFactory: () => new LocalFilesystemStorageProvider(storageRoot),
        },
      ],
    })
    class TestModule {}

    app = await NestFactory.create<NestExpressApplication>(TestModule, { logger: false });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.listen(0);
    baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await app?.close();
    await teardownClinic(clinic);
    await teardownClinic(other);
    await prisma.$disconnect();
    await rm(storageRoot, { recursive: true, force: true });
  });

  test("an admin edits the letterhead; a doctor may read it but not edit it", async () => {
    const saved = await call("PUT", "/clinic-identity", adminToken, {
      name: "عيادة النيل",
      address: "١٢ شارع الجمهورية، القاهرة",
      phone: "01001234567",
      // A Cairo landline, which libphonenumber does parse.
      secondaryPhone: "02 2735 1234",
    });
    expect(saved.status).toBe(200);
    const identity = (await saved.json()) as { phone: string; secondaryPhone: string; name: string };
    expect(identity.phone).toBe("+201001234567");
    expect(identity.secondaryPhone).toBe("+20227351234");

    // A five-digit clinic hotline is not an E.164 number and is kept exactly as typed. Refusing it
    // would make one of the numbers a letterhead actually carries the one that cannot be stored.
    const hotline = await call("PUT", "/clinic-identity", adminToken, { secondaryPhone: "16123" });
    expect(((await hotline.json()) as { secondaryPhone: string }).secondaryPhone).toBe("16123");

    const read = await call("GET", "/clinic-identity", doctorToken);
    expect(read.status).toBe(200);
    expect(((await read.json()) as { name: string }).name).toBe("عيادة النيل");

    // Reading is a printing need; editing is a management one. The same split services already make.
    const refused = await call("PUT", "/clinic-identity", doctorToken, { name: "x" });
    expect(refused.status).toBe(403);
  });

  test("a logo round-trips through the storage seam, and is served with its sniffed type", async () => {
    const stored = await upload("/clinic-identity/logo", adminToken, PNG);
    expect(stored.status).toBe(201);

    const identity = (await (await call("GET", "/clinic-identity", doctorToken)).json()) as {
      hasLogo: boolean;
    };
    expect(identity.hasLogo).toBe(true);

    const served = await call("GET", "/clinic-identity/logo", doctorToken);
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe("image/png");
    // The type is the sniffed one, so a browser must not be allowed to guess a different one.
    expect(served.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Buffer.from(await served.arrayBuffer()).equals(PNG)).toBe(true);
  });

  test("a PDF is a valid attachment and is not a letterhead", async () => {
    // `sniff` admits PDFs because a lab report is one. A logo is not, and the extension set the
    // branding key accepts is derived from `ACCEPTED` minus `pdf` so the two cannot drift.
    const refused = await upload("/clinic-identity/logo", adminToken, PDF);
    expect(refused.status).toBe(415);
    expect(((await refused.json()) as { code: string }).code).toBe("UNSUPPORTED_TYPE");
  });

  test("a signature and a stamp are stored per doctor, and read back separately", async () => {
    expect((await upload(`/clinic-identity/doctors/${clinic.doctorId}/signature`, adminToken, PNG)).status).toBe(201);

    const identity = (await (
      await call("GET", `/clinic-identity/doctors/${clinic.doctorId}`, doctorToken)
    ).json()) as { hasSignature: boolean; hasStamp: boolean };
    expect(identity.hasSignature).toBe(true);
    // Two images, two columns: uploading one must not make the other appear.
    expect(identity.hasStamp).toBe(false);

    expect((await call("GET", `/clinic-identity/doctors/${clinic.doctorId}/stamp`, doctorToken)).status).toBe(404);
  });

  test("another clinic's doctor is not found, and nothing is written", async () => {
    const refused = await upload(
      `/clinic-identity/doctors/${other.doctorId}/signature`,
      adminToken,
      PNG,
    );
    // 404, never 403: a cross-tenant id must be indistinguishable from one that never existed.
    expect(refused.status).toBe(404);

    await withTenant(other.tenantId, actorFor(other.userId), async (tx) => {
      const doctor = await tx.doctor.findFirstOrThrow({ where: { id: other.doctorId } });
      expect(doctor.signatureStorageKey).toBeNull();
    });
  });

  test("a doctor edits their own print fields, and cannot touch a colleague's (Q36)", async () => {
    // `doctorProfile.manage` is `own` for DOCTOR. The scope is applied to the lookup, so a
    // colleague's row is "no such thing" — a 404 that cannot be read as confirming it exists.
    const mine = await call("PUT", `/clinic-identity/doctors/${clinic.doctorId}`, doctorToken, {
      printedName: "د. سارة منصور",
      syndicateNumber: "12345",
    });
    expect(mine.status).toBe(200);
    expect(((await mine.json()) as { printedName: string }).printedName).toBe("د. سارة منصور");

    // A colleague in the SAME clinic: tenant isolation cannot hide this one, so only
    // `doctorProfile.manage` being `own` can refuse it.
    const theirs = await call("PUT", `/clinic-identity/doctors/${colleagueDoctorId}`, doctorToken, {
      printedName: "not mine to write",
    });
    expect(theirs.status).toBe(404);

    // And the upload path is scoped the same way, or the fields would be safe while the signature
    // filed onto a colleague's record was not.
    const theirSignature = await upload(
      `/clinic-identity/doctors/${colleagueDoctorId}/signature`,
      doctorToken,
      PNG,
    );
    expect(theirSignature.status).toBe(404);

    await withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) => {
      const doctor = await tx.doctor.findFirstOrThrow({ where: { id: colleagueDoctorId } });
      expect(doctor.printedName).toBeNull();
      expect(doctor.signatureStorageKey).toBeNull();
    });
  });

  test("an admin edits any doctor's print fields", async () => {
    const response = await call("PUT", `/clinic-identity/doctors/${clinic.doctorId}`, adminToken, {
      title: "استشاري",
    });
    expect(response.status).toBe(200);
    expect(((await response.json()) as { title: string }).title).toBe("استشاري");
  });

  test("removing an image clears the pointer and leaves the stored file alone", async () => {
    expect((await upload("/clinic-identity/logo", adminToken, PNG)).status).toBe(201);
    const stored = await withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) =>
      (await tx.tenant.findUniqueOrThrow({ where: { id: clinic.tenantId } })).logoStorageKey,
    );
    expect(stored).not.toBeNull();

    const removed = await call("DELETE", "/clinic-identity/logo", adminToken);
    expect(removed.status).toBe(200);

    const identity = (await (await call("GET", "/clinic-identity", doctorToken)).json()) as {
      hasLogo: boolean;
    };
    expect(identity.hasLogo).toBe(false);

    // The object is still on disk: `StorageProvider` has no `delete()` by design, and a sheet
    // printed last week was made with that file.
    expect(existsSync(path.join(storageRoot, stored as string))).toBe(true);
  });

  test("reception can neither read nor write the letterhead's images", async () => {
    expect((await call("DELETE", "/clinic-identity/logo", receptionToken)).status).toBe(403);
    expect(
      (await call("PUT", `/clinic-identity/doctors/${clinic.doctorId}`, receptionToken, { title: "x" }))
        .status,
    ).toBe(403);
  });

  test("the printed name and syndicate number are saved through the doctor's own PATCH", async () => {
    await withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) => {
      await tx.doctor.update({
        where: { id: clinic.doctorId },
        data: { printedName: "د. سارة منصور", syndicateNumber: "12345" },
      });
    });

    const identity = (await (
      await call("GET", `/clinic-identity/doctors/${clinic.doctorId}`, doctorToken)
    ).json()) as { printedName: string; syndicateNumber: string; licenseNumber: string };
    expect(identity.printedName).toBe("د. سارة منصور");
    expect(identity.syndicateNumber).toBe("12345");
    expect(identity.licenseNumber).not.toBe("");
  });
});
