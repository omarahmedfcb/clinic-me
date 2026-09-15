import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Module, ValidationPipe } from "@nestjs/common";
import { APP_INTERCEPTOR, NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { ActorContextInterceptor } from "../../src/common/actor-context.interceptor.ts";
import { issueAccessToken } from "../../src/modules/auth/jwt.ts";
import { AttachmentsController } from "../../src/modules/attachments/attachments.controller.ts";
import { AttachmentsSummaryController } from "../../src/modules/attachments/attachments-summary.controller.ts";
import { LocalFilesystemStorageProvider } from "../../src/modules/attachments/storage/local-filesystem.provider.ts";
import { STORAGE_PROVIDER } from "../../src/modules/attachments/storage/storage-provider.ts";
import { ClinicalController } from "../../src/modules/clinical/clinical.controller.ts";
import { InsuranceController } from "../../src/modules/insurance/insurance.controller.ts";
import { NotificationsController } from "../../src/modules/notifications/notifications.controller.ts";
import { PatientsController } from "../../src/modules/patients/patients.controller.ts";
import { QueueController } from "../../src/modules/queue/queue.controller.ts";
import { TransfersController } from "../../src/modules/transfers/transfers.controller.ts";
import { prisma } from "../../src/prisma/client.ts";
import { injected } from "../../src/prisma/injected.ts";
import { withTenant } from "../../src/prisma/with-tenant.ts";
import { actorFor, createTestUser, seedClinic, teardownClinic, type ClinicFixture } from "./fixtures.ts";

/**
 * **No reception-facing endpoint returns clinical content. All of them, in one place.**
 *
 * `ARCHITECTURE.md` §8 states the rule as *separate endpoints and separate DTOs, never filtering
 * fields out of one response*. The founder's sharper version of the risk, and the reason this file
 * exists: **a DTO boundary means nothing if a relation is included wholesale beneath it.** A
 * hand-written response type says exactly nothing about what
 * `include: { patient: true }` drags along under it, and a reviewer reading the DTO would see no
 * problem at all.
 *
 * Auditing the includes by eye answers the question for today and expires the moment someone adds
 * one. So the guard is behavioural and total: real clinical content is written, a **doctor** is
 * shown to reach it (or the whole file proves nothing), and then every reception-facing endpoint in
 * the product is swept for it as raw response text.
 *
 * Raw text, not field-by-field assertions, on purpose: a nested object passes a key check and fails
 * this one. That is precisely the failure being guarded against.
 *
 * **Adding an endpoint means adding it to `RECEPTION_FACING` below.** That list is the point of the
 * file — an endpoint nobody adds is an endpoint nobody sweeps.
 */
@Module({
  controllers: [
    AttachmentsController,
    AttachmentsSummaryController,
    QueueController,
    PatientsController,
    InsuranceController,
    ClinicalController,
    TransfersController,
    NotificationsController,
  ],
  providers: [
    { provide: APP_INTERCEPTOR, useClass: ActorContextInterceptor },
    // The doctor's attachment list is needed only to prove the filename sentinel is reachable at
    // all. No bytes are read, so the root is a scratch directory that stays empty.
    {
      provide: STORAGE_PROVIDER,
      useFactory: () => new LocalFilesystemStorageProvider(mkdtempSync(join(tmpdir(), "leak-guard-"))),
    },
  ],
})
class LeakGuardTestModule {}

/** Distinctive strings. If any of these appears in a reception payload, it came from a visit row. */
const SENTINELS = {
  diagnosis: "SENTINEL-DIAGNOSIS-acute-sinusitis",
  examination: "SENTINEL-EXAMINATION-chest-clear",
  treatmentPlan: "SENTINEL-TREATMENTPLAN-amoxicillin-course",
  doctorNotes: "SENTINEL-DOCTORNOTES-discussed-prognosis",
  medicalHistory: "SENTINEL-MEDICALHISTORY-asthma-since-childhood",
  /**
   * **An attachment filename, added 2026-09-05, because the sweep could not see this class of
   * leak.**
   *
   * The reception-facing attachment summary joined the list above and the sweep still passed with
   * `fileName` deliberately selected into reception's payload — every sentinel was a `visits`
   * column, so nothing in the fixture could appear in an attachment response no matter how badly it
   * leaked. The endpoint was swept and the sweep was blind to it.
   *
   * A filename is clinical content in the same way a diagnosis is: `أشعة_الركبة_اليمنى.pdf` names
   * the condition. So it gets a sentinel, and re-running the deliberate leak now turns this file
   * red as well as the attachment spec.
   */
  attachmentFileName: "SENTINEL-ATTACHMENT-right-knee-mri.pdf",
  /**
   * Vitals and the clinical profile, added 2026-09-08 with PR 7b, for the same reason the filename
   * sentinel was added: a sweep can only find content it planted.
   *
   * A weight is clinical content. So is a family history of breast cancer — arguably the most
   * sensitive field in the system, and it lives in its own table precisely so a reception read
   * cannot join to it by accident.
   */
  vitalsMarker: "SENTINEL-VITALS-97531",
  familyHistory: "SENTINEL-FAMILYHISTORY-maternal-brca",
  riskFactors: "SENTINEL-RISKFACTORS-thirty-pack-years",
};

describe("no reception-facing endpoint returns clinical content", () => {
  let app: NestExpressApplication;
  let baseUrl: string;
  let clinic: ClinicFixture;

  let receptionToken: string;
  let doctorToken: string;
  let patientId: string;
  let appointmentId: string;

  const today = new Date().toISOString().slice(0, 10);

  const get = async (path: string, token: string): Promise<{ status: number; text: string }> => {
    const response = await fetch(`${baseUrl}${path}`, { headers: { authorization: `Bearer ${token}` } });
    return { status: response.status, text: await response.text() };
  };

  beforeAll(async () => {
    clinic = await seedClinic();

    await withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) => {
      patientId = randomUUID();
      await tx.patient.create({
        data: injected({
          id: patientId,
          fullNameAr: "مريض الاختبار",
          phoneE164: `+2019${patientId.replace(/-/g, "").slice(0, 7)}`,
          relationshipToContact: "SELF",
          status: "ACTIVE",
        }),
      });

      // On TODAY's queue, and IN_CONSULTATION so the patient is "present" -- which is what makes the
      // doctor's read of clinical-history succeed, and therefore what makes this file non-vacuous.
      appointmentId = randomUUID();
      const start = new Date();
      await tx.appointment.create({
        data: injected({
          id: appointmentId,
          patientId,
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

      // An attachment carrying a sentinel filename. Written directly rather than uploaded, because
      // the sweep reads metadata and needs no bytes -- and a fixture that needed a storage provider
      // would couple this file to the upload path it is not testing.
      await tx.attachment.create({
        data: injected({
          id: randomUUID(),
          patientId,
          visitId: null,
          uploadedByUserId: clinic.userId,
          fileName: SENTINELS.attachmentFileName,
          storageKey: `${clinic.tenantId}/${patientId}/${randomUUID()}.pdf`,
          mimeType: "application/pdf",
          sizeBytes: 2048,
          category: "IMAGING",
          description: null,
        }),
      });

      await tx.visit.create({
        data: injected({
          id: randomUUID(),
          patientId,
          doctorId: clinic.doctorId,
          appointmentId,
          complaint: "صداع",
          medicalHistory: SENTINELS.medicalHistory,
          examination: SENTINELS.examination,
          diagnosis: SENTINELS.diagnosis,
          treatmentPlan: SENTINELS.treatmentPlan,
          doctorNotes: SENTINELS.doctorNotes,
          // The marker is a value inside the JSON, so a payload that serialised the whole column
          // would carry it — which is what a leak of vitals would look like.
          vitals: { weightKg: 72.5, note: SENTINELS.vitalsMarker },
          status: "COMPLETED",
          createdBy: clinic.userId,
        }),
      });
    });

    // The clinical profile. In its own table, which is exactly why it needs its own sentinel: no
    // amount of leaking from `visits` could ever surface a family history.
    await withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) => {
      await tx.patientClinicalProfileEntry.create({
        data: injected({
          id: randomUUID(),
          patientId,
          field: "FAMILY_HISTORY",
          content: SENTINELS.familyHistory,
          authorUserId: clinic.userId,
        }),
      });
      await tx.patientClinicalProfileEntry.create({
        data: injected({
          id: randomUUID(),
          patientId,
          field: "RISK_FACTORS",
          content: SENTINELS.riskFactors,
          authorUserId: clinic.userId,
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
    receptionToken = await issueAccessToken({
      sub: receptionUserId,
      membershipId: receptionMembershipId,
      tenantId: clinic.tenantId,
      role: "RECEPTIONIST",
    });
    doctorToken = await issueAccessToken({
      sub: clinic.userId,
      membershipId: clinic.membershipId,
      tenantId: clinic.tenantId,
      role: "DOCTOR",
    });

    app = await NestFactory.create<NestExpressApplication>(LeakGuardTestModule, { logger: false });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    await app.listen(0, "127.0.0.1");
    baseUrl = `http://127.0.0.1:${((app.getHttpServer() as Server).address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    if (app !== undefined) await app.close();
    await teardownClinic(clinic);
    await prisma.$disconnect();
  });

  /**
   * Without these two the whole file proves nothing: a sweep that finds no sentinel because no
   * sentinel exists anywhere is a green run that checked nothing.
   *
   * Two assertions rather than one, because the sentinels now live in two tables and reach a doctor
   * by two different routes. Asserting them all against `clinical-history` was what failed when the
   * attachment sentinel was added — correctly, because a filename does not appear there.
   */
  test("the visit content exists and a doctor reaches it", async () => {
    const history = await get(`/appointments/${appointmentId}/clinical-history`, doctorToken);
    expect(history.status).toBe(200);
    // Three sentinels are reached through their own endpoints, asserted in the tests below. They
    // are skipped here rather than dropped: a sentinel nobody proves reachable is a sentinel the
    // sweep can never find, which is how the attachment leak survived a green run.
    const elsewhere = ["attachmentFileName", "vitalsMarker", "familyHistory", "riskFactors"];
    for (const [field, sentinel] of Object.entries(SENTINELS)) {
      if (elsewhere.includes(field)) continue;
      expect(history.text).toContain(sentinel);
    }
  });

  test("the vitals exist and a doctor reaches them", async () => {
    const visit = await get(`/appointments/${appointmentId}/visit`, doctorToken);
    expect(visit.status).toBe(200);
    expect(visit.text).toContain(SENTINELS.vitalsMarker);
  });

  test("the clinical profile exists and a doctor reaches it", async () => {
    const profile = await get(`/appointments/${appointmentId}/clinical-profile`, doctorToken);
    expect(profile.status).toBe(200);
    expect(profile.text).toContain(SENTINELS.familyHistory);
    expect(profile.text).toContain(SENTINELS.riskFactors);
  });

  test("the attachment filename exists and a doctor reaches it", async () => {
    const list = await get(`/patients/${patientId}/attachments`, doctorToken);
    expect(list.status).toBe(200);
    expect(list.text).toContain(SENTINELS.attachmentFileName);
  });

  describe("the sweep", () => {
    /**
     * Every GET reception can reach. **Add an endpoint here when you add one to the product** —
     * a route nobody lists is a route nobody sweeps, which is how `/no-shows/pending` escaped the
     * ownership audit that was framed around endpoints taking a `doctorId` (PR #30, `c84b0ed`).
     */
    const receptionFacing = (): { name: string; path: string }[] => [
      { name: "the queue board", path: `/queue/today?date=${today}` },
      { name: "the no-show list", path: `/no-shows/pending?date=${today}` },
      { name: "patient search", path: `/patients?q=${encodeURIComponent("مريض")}` },
      { name: "the patient book", path: "/patients/recent?limit=50" },
      { name: "the patient profile", path: `/patients/${patientId}` },
      { name: "visit history metadata", path: `/patients/${patientId}/visits` },
      { name: "appointment history", path: `/patients/${patientId}/appointments` },
      { name: "the outstanding balance", path: `/patients/${patientId}/balance` },
      { name: "the insurance block", path: `/patients/${patientId}/insurance` },
      { name: "the appointment detail panel", path: `/appointments/${appointmentId}/detail` },
      { name: "the transfer list", path: `/transfers?openOnly=false` },
      { name: "the notification list", path: `/notifications` },
      { name: "the notification count", path: `/notifications/count` },
      // Reception-facing since 2026-09-05: which documents exist, never what they contain. The
      // filename is the field this sweep is guarding against here -- it is the one attachment
      // column that describes contents rather than existence.
      { name: "the attachment summary", path: `/patients/${patientId}/attachment-summary` },
    ];

    /**
     * One test that sweeps every route, rather than `test.each` over the list.
     *
     * `test.each` evaluates its table at **collection** time — before `beforeAll` has run — so the
     * ids interpolated into these paths were still `undefined` and every request 400'd. The sweep
     * then "passed" for four routes for the worst possible reason: a broken URL returns no clinical
     * content either. The `expect(status).toBe(200)` below is what caught it, and is the reason it
     * is written before the sentinel check rather than after.
     */
    test("every reception-facing endpoint answers 200 and carries no clinical content", async () => {
      const findings: { name: string; status: number; leaked: string[] }[] = [];

      for (const { name, path } of receptionFacing()) {
        const reply = await get(path, receptionToken);
        findings.push({
          name,
          status: reply.status,
          leaked: Object.entries(SENTINELS)
            .filter(([, sentinel]) => reply.text.includes(sentinel))
            .map(([field]) => field),
        });
      }

      // Reported as data, so a failure names the route and the field rather than a bare boolean.
      expect(findings).toEqual(
        receptionFacing().map(({ name }) => ({ name, status: 200, leaked: [] })),
      );
    });

    test("the queue board really does describe this patient, so its sweep is not vacuous", async () => {
      // The one endpoint the founder named. Asserted separately because "no clinical content" is
      // trivially true of a response that does not mention the patient at all.
      const board = await get(`/queue/today?date=${today}`, receptionToken);
      expect(board.text).toContain(patientId);
      expect(board.text).toContain("مريض الاختبار");
    });
  });

  test("the clinical routes themselves refuse reception at the guard", async () => {
    // Refused before any handler runs: `visits.readContent` is NONE for RECEPTIONIST. Not a
    // filtered response -- reception never reaches the code that reads a diagnosis.
    expect((await get(`/appointments/${appointmentId}/clinical-summary`, receptionToken)).status).toBe(403);
    expect((await get(`/appointments/${appointmentId}/clinical-history`, receptionToken)).status).toBe(403);
  });
});
