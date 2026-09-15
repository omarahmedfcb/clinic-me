import { randomUUID } from "node:crypto";
import { Module, ValidationPipe } from "@nestjs/common";
import { APP_INTERCEPTOR, NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import type { AddressInfo } from "node:net";
import { ActorContextInterceptor } from "../../src/common/actor-context.interceptor.ts";
import { issueAccessToken } from "../../src/modules/auth/jwt.ts";
import { PatientsController } from "../../src/modules/patients/patients.controller.ts";
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
 * **Reception may edit the patient record and may not write a clinical field through it** — the
 * guard the founder attached to Q42, when patient detail became editable.
 *
 * The structural answer is that `patients` carries no clinical column: diagnosis, examination, the
 * profile and the allergy list all live in their own tables behind `visits.readContent`. That is a
 * good design and a poor guard on its own — it is true today because nobody has added a column, and
 * "nobody has added a column" is exactly the thing that changes.
 *
 * So this asserts the boundary from the outside: a receptionist naming a clinical field on the
 * patient PATCH is **refused by the DTO whitelist**, not quietly ignored. Quiet ignoring is the
 * dangerous half — the request succeeds, the field does not land, and nothing tells anybody.
 */

@Module({
  controllers: [PatientsController],
  providers: [{ provide: APP_INTERCEPTOR, useClass: ActorContextInterceptor }],
})
class ReceptionWriteTestModule {}

/** Names a clinician authors. None of them is a column on `patients`, and none may become one. */
const CLINICAL_FIELDS = [
  "diagnosis",
  "complaint",
  "examination",
  "treatmentPlan",
  "doctorNotes",
  "medicalHistory",
  "investigations",
  "vitals",
  "allergies",
  "familyHistory",
  "riskFactors",
];

describe("reception edits the patient record and nothing clinical", () => {
  let app: NestExpressApplication;
  let baseUrl: string;
  let clinic: ClinicFixture;
  let receptionToken = "";

  const call = async (method: string, path: string, body?: unknown): Promise<Response> =>
    fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${receptionToken}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  beforeAll(async () => {
    clinic = await seedClinic();

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

    app = await NestFactory.create<NestExpressApplication>(ReceptionWriteTestModule, { logger: false });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.listen(0);
    baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await app?.close();
    await teardownClinic(clinic);
    await prisma.$disconnect();
  });

  test("reception can correct the personal and contact details it reads", async () => {
    // Asserted first, so the refusals below cannot be mistaken for reception having lost the record.
    const saved = await call("PATCH", `/patients/${clinic.patientId}`, {
      fullNameAr: "مريم حسن عبد الله",
      secondaryPhone: "+201009998888",
      gender: "FEMALE",
      address: "١٢ شارع النصر، المعادي",
    });
    expect(saved.status).toBe(200);

    await withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) => {
      const patient = await tx.patient.findFirstOrThrow({ where: { id: clinic.patientId } });
      expect(patient.fullNameAr).toBe("مريم حسن عبد الله");
      expect(patient.gender).toBe("FEMALE");
    });
  });

  test("a clinical field on the patient PATCH is refused, not ignored", async () => {
    for (const field of CLINICAL_FIELDS) {
      const response = await call("PATCH", `/patients/${clinic.patientId}`, {
        fullNameAr: "مريم حسن عبد الله",
        [field]: "SENTINEL-CLINICAL-CONTENT",
      });
      // `forbidNonWhitelisted` is what makes this a refusal rather than a silent drop, and the
      // silent drop is the dangerous half: the request succeeds, nothing lands, nobody is told.
      expect({ field, status: response.status }).toEqual({ field, status: 400 });
    }
  });

  test("and nothing clinical was written on the way to refusing", async () => {
    await withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) => {
      const raw = JSON.stringify(
        await tx.patient.findFirstOrThrow({ where: { id: clinic.patientId } }),
      );
      expect(raw).not.toContain("SENTINEL-CLINICAL-CONTENT");
      // Nor did it leak sideways into the clinical tables reception cannot read.
      expect(await tx.patientClinicalProfileEntry.count({ where: { patientId: clinic.patientId } })).toBe(0);
    });
  });
});
