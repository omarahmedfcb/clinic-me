import { ThrottlingModule } from "../../src/common/throttling.module.ts";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Module, ValidationPipe } from "@nestjs/common";
import { APP_INTERCEPTOR, NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { ActorContextInterceptor } from "../../src/common/actor-context.interceptor.ts";
import { AttachmentsController } from "../../src/modules/attachments/attachments.controller.ts";
import { LocalFilesystemStorageProvider } from "../../src/modules/attachments/storage/local-filesystem.provider.ts";
import { STORAGE_PROVIDER } from "../../src/modules/attachments/storage/storage-provider.ts";
import { issueAccessToken } from "../../src/modules/auth/jwt.ts";
import { ClinicalController } from "../../src/modules/clinical/clinical.controller.ts";
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

/**
 * `GET /appointments/:id/visit` — `PHASE-4.md` Q18, **as revised 2026-09-05**.
 *
 * Two rulings changed what this file has to prove, and both reversals are pinned here rather than
 * described:
 *
 * - **The route is appointment-scoped.** A visit-scoped `GET /visits/:id` was built first and
 *   reversed, because it carried its own ownership logic. Ownership now comes from `resolveAccess`,
 *   the same function `clinical-summary` and `clinical-history` use.
 * - **There is no "but I wrote it" exception.** The first version let an author read their own visit
 *   unconditionally. The rule is now *current ownership or an active grant*, and the test that
 *   matters most below is the one where the **author is refused** — because that is the assertion
 *   the reverted behaviour would break.
 */

let storageRoot = "";

@Module({
  // The upload route is rate-limited (4b), so its guard needs the throttler options in scope.
  imports: [ThrottlingModule],
  controllers: [ClinicalController, AttachmentsController],
  providers: [
    { provide: APP_INTERCEPTOR, useClass: ActorContextInterceptor },
    { provide: STORAGE_PROVIDER, useFactory: () => new LocalFilesystemStorageProvider(storageRoot) },
  ],
})
class VisitDetailTestModule {}

const PDF_BYTES = Buffer.from("%PDF-1.7\nvisit detail fixture\n");

/** Distinctive strings. If one appears where it should not, it came from this visit row. */
const SENTINELS = {
  examination: "SENTINEL-EXAM-chest-clear-on-auscultation",
  diagnosis: "SENTINEL-DX-acute-sinusitis",
  doctorNotes: "SENTINEL-NOTES-discussed-prognosis-at-length",
  treatmentPlan: "SENTINEL-PLAN-amoxicillin-seven-days",
  medicalHistory: "SENTINEL-HX-asthma-since-childhood",
};

describe("GET /appointments/:id/visit", () => {
  let app: NestExpressApplication;
  let baseUrl: string;
  let clinic: ClinicFixture;
  let otherClinic: ClinicFixture;

  let doctorToken: string;
  let receptionToken: string;
  let otherTenantDoctorToken: string;

  /** The doctor's own, a month ago, COMPLETED — the patient is long gone. */
  let pastAppointmentId = "";
  /** The doctor's own, now, IN_CONSULTATION — the patient is in the room. */
  let liveAppointmentId = "";
  /** An appointment with no visit recorded against it. */
  let emptyAppointmentId = "";
  /** A different patient, seen once and gone — no current appointment with anyone. */
  let movedOnPatientId = "";
  let movedOnAppointmentId = "";
  let strangerPatientId = "";
  let strangerAppointmentId = "";

  const get = async (path: string, token: string): Promise<Response> =>
    fetch(`${baseUrl}${path}`, { headers: { authorization: `Bearer ${token}` } });

  const countSensitiveReads = async (): Promise<number> =>
    withTenant(clinic.tenantId, actorFor(clinic.userId), (tx) =>
      tx.auditLog.count({ where: { action: "READ_SENSITIVE", entityId: clinic.patientId } }),
    );

  /** A second doctor in this tenant, with no relationship to the fixture patient. */
  const colleague = async (): Promise<{ token: string; doctorId: string; membershipId: string }> => {
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
    return { token, doctorId, membershipId };
  };

  /** An appointment for the fixture patient, at an offset that cannot collide with another. */
  const appointmentFor = async (input: {
    doctorId: string;
    status: "COMPLETED" | "IN_CONSULTATION";
    minutesFromNow: number;
    patientId?: string;
  }): Promise<string> => {
    const id = randomUUID();
    await withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) => {
      const start = new Date(Date.now() + input.minutesFromNow * 60_000);
      const present = input.status === "IN_CONSULTATION";
      await tx.appointment.create({
        data: injected({
          id,
          patientId: input.patientId ?? clinic.patientId,
          doctorId: input.doctorId,
          serviceId: clinic.serviceId,
          scheduledStart: start,
          scheduledEnd: new Date(start.getTime() + 20 * 60_000),
          status: input.status,
          source: "RECEPTION",
          ...(present
            ? { arrivedAt: start, waitingStartedAt: start, consultationStartedAt: start }
            : {}),
          createdBy: clinic.userId,
          updatedBy: clinic.userId,
        }),
      });
    });
    return id;
  };

  const visitFor = async (
    appointmentId: string,
    doctorId: string,
    complaint: string,
    patientId: string = clinic.patientId,
  ): Promise<string> => {
    const id = randomUUID();
    await withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) => {
      await tx.visit.create({
        data: injected({
          id,
          patientId,
          doctorId,
          appointmentId,
          complaint,
          medicalHistory: SENTINELS.medicalHistory,
          examination: SENTINELS.examination,
          diagnosis: SENTINELS.diagnosis,
          treatmentPlan: SENTINELS.treatmentPlan,
          doctorNotes: SENTINELS.doctorNotes,
          followUpDate: new Date("2026-10-01"),
          followUpIntervalDays: 14,
          status: "COMPLETED",
          createdBy: clinic.userId,
        }),
      });
    });
    return id;
  };

  beforeAll(async () => {
    storageRoot = await mkdtemp(join(tmpdir(), "clinic-os-visit-detail-"));
    clinic = await seedClinic();
    otherClinic = await seedClinic();

    // -30 days: the doctor's own appointment, finished, patient long gone.
    pastAppointmentId = await appointmentFor({
      doctorId: clinic.doctorId,
      status: "COMPLETED",
      minutesFromNow: -43_200,
    });
    await visitFor(pastAppointmentId, clinic.doctorId, "صداع مستمر");

    // Now: the doctor's own, patient in the room.
    liveAppointmentId = await appointmentFor({
      doctorId: clinic.doctorId,
      status: "IN_CONSULTATION",
      minutesFromNow: 0,
    });
    await visitFor(liveAppointmentId, clinic.doctorId, "متابعة");

    // Deliberately no visit written against it, and IN_CONSULTATION so the access check passes
    // and the *existence* check is what answers. Two hours out so it cannot overlap the live one --
    // `no_double_booking` is a real exclusion constraint, not a convention.
    emptyAppointmentId = await appointmentFor({
      doctorId: clinic.doctorId,
      status: "IN_CONSULTATION",
      minutesFromNow: 120,
    });

    // A patient this doctor treated once and no longer treats. Nothing current, anywhere.
    movedOnPatientId = randomUUID();
    await withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) => {
      await tx.patient.create({
        data: injected({
          id: movedOnPatientId,
          fullNameAr: "مريض سابق",
          phoneE164: generateFixturePhone(),
          relationshipToContact: "SELF",
          status: "ACTIVE",
        }),
      });
    });
    movedOnAppointmentId = await appointmentFor({
      doctorId: clinic.doctorId,
      status: "COMPLETED",
      minutesFromNow: -100_000,
      patientId: movedOnPatientId,
    });
    await visitFor(movedOnAppointmentId, clinic.doctorId, "زيارة قديمة", movedOnPatientId);

    // R-B's other side: a patient this doctor has **never** treated, seen by a colleague instead.
    // The fixture the guard needs — "a doctor cannot read a patient they never treated".
    const stranger = await colleague();
    strangerPatientId = randomUUID();
    await withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) => {
      await tx.patient.create({
        data: injected({
          id: strangerPatientId,
          fullNameAr: "مريض طبيب آخر",
          phoneE164: generateFixturePhone(),
          relationshipToContact: "SELF",
          status: "ACTIVE",
        }),
      });
    });
    strangerAppointmentId = await appointmentFor({
      doctorId: stranger.doctorId,
      status: "COMPLETED",
      minutesFromNow: -110_000,
      patientId: strangerPatientId,
    });
    await visitFor(strangerAppointmentId, stranger.doctorId, "زيارة عند زميل", strangerPatientId);

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

    app = await NestFactory.create<NestExpressApplication>(VisitDetailTestModule, { logger: false });
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

  describe("current ownership opens it", () => {
    test("the treating doctor reads the visit while the patient is with them", async () => {
      const response = await get(`/appointments/${liveAppointmentId}/visit`, doctorToken);
      expect(response.status).toBe(200);

      const visit = (await response.json()) as Record<string, unknown>;
      expect(visit).toMatchObject({
        patientId: clinic.patientId,
        doctorId: clinic.doctorId,
        appointmentId: liveAppointmentId,
        status: "COMPLETED",
        complaint: "متابعة",
        medicalHistory: SENTINELS.medicalHistory,
        examination: SENTINELS.examination,
        diagnosis: SENTINELS.diagnosis,
        treatmentPlan: SENTINELS.treatmentPlan,
        doctorNotes: SENTINELS.doctorNotes,
        followUpIntervalDays: 14,
      });
    });

    test("the payload is the full record, not a summary", async () => {
      const text = await (await get(`/appointments/${liveAppointmentId}/visit`, doctorToken)).text();
      for (const sentinel of Object.values(SENTINELS)) expect(text).toContain(sentinel);
    });

    test("reading your own patient writes no READ_SENSITIVE row", async () => {
      const before = await countSensitiveReads();
      await get(`/appointments/${liveAppointmentId}/visit`, doctorToken);
      expect(await countSensitiveReads()).toBe(before);
    });

    test("an appointment with no visit recorded is 404, not an empty object", async () => {
      const response = await get(`/appointments/${emptyAppointmentId}/visit`, doctorToken);
      expect(response.status).toBe(404);
    });

    /**
     * Access is decided **before** existence, and the ordering is worth pinning.
     *
     * A caller who may not see the appointment gets the same 409 whether or not a visit was ever
     * written against it, so the response cannot be used to learn that a patient has a record. The
     * 404 above is only reachable by someone already entitled to the content.
     */
    test("a caller without access cannot tell a missing visit from a forbidden one", async () => {
      const { token } = await colleague();
      const missing = await get(`/appointments/${emptyAppointmentId}/visit`, token);
      const present = await get(`/appointments/${liveAppointmentId}/visit`, token);
      expect(missing.status).toBe(409);
      expect(present.status).toBe(409);
    });
  });

  /**
   * **R-B, ruled by the founder 2026-09-14, and it reverses the 2026-09-05 revision of Q18.**
   *
   * What changed: *"a doctor may READ the full record of any patient who has a completed visit with
   * them… Writing still requires presence or an accepted transfer."* His 2026-09-05 objection was
   * to **authorship** — "having once written a note" — accumulating permanent access. A completed
   * visit is a narrower fact and the door it opens is narrower too: reading only.
   *
   * The line the tests below hold is therefore not "past versus present" any more. It is **treated
   * versus never treated**, and the second half is the guard he attached to the ruling.
   */
  describe("a doctor's own past patients open; a stranger's stay shut", () => {
    test("the doctor who treated this patient may read the record after they have moved on", async () => {
      const response = await get(`/appointments/${movedOnAppointmentId}/visit`, doctorToken);

      expect(response.status).toBe(200);
      const visit = (await response.json()) as { diagnosis: string; appointmentId: string };
      expect(visit.appointmentId).toBe(movedOnAppointmentId);
      expect(visit.diagnosis).toBe(SENTINELS.diagnosis);
    });

    /**
     * **The guard R-B names: a doctor cannot read a patient they never treated.**
     *
     * This doctor has a patient in the room and a shelf of their own past patients. Neither is a
     * key to a colleague's patient — the door R-B opens is one completed visit wide.
     */
    test("a patient this doctor never treated is refused, and the refusal leaks nothing", async () => {
      const response = await get(`/appointments/${strangerAppointmentId}/visit`, doctorToken);
      expect(response.status).toBe(409);
      const text = await response.text();
      expect(JSON.parse(text)).toMatchObject({ code: "NOT_PRESENT" });
      for (const sentinel of Object.values(SENTINELS)) expect(text).not.toContain(sentinel);
    });

    /**
     * The half that predates R-B and still carries the feature.
     *
     * The appointment is a month old and `COMPLETED`; the *patient* is in the room right now on a
     * different appointment. Without this, every entry in the navigable history list refuses —
     * measured, not supposed: on the review stack `clinical-history` returned three past visits'
     * content while opening any of them was refused 409.
     */
    test("a past visit opens while that patient is currently in the doctor's care", async () => {
      const response = await get(`/appointments/${pastAppointmentId}/visit`, doctorToken);

      expect(response.status).toBe(200);
      const visit = (await response.json()) as { diagnosis: string; appointmentId: string };
      expect(visit.appointmentId).toBe(pastAppointmentId);
      expect(visit.diagnosis).toBe(SENTINELS.diagnosis);
    });

    /** Reading is not writing: R-B says so, and the write gate is a different flag. */
    test("a past patient of one's own cannot be written to", async () => {
      const response = await fetch(`${baseUrl}/appointments/${movedOnAppointmentId}/visit/draft`, {
        method: "POST",
        headers: { authorization: `Bearer ${doctorToken}` },
      });
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: "NOT_PRESENT" });
    });
  });

  describe("a transfer grant composes, without this route mentioning transfers", () => {
    test("an accepted grant opens a colleague's appointment, and is audited", async () => {
      const { token, doctorId, membershipId } = await colleague();

      // The grant hangs off an occasion -- an appointment -- and its window runs from decidedAt.
      await withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) => {
        await tx.patientTransfer.create({
          data: injected({
            id: randomUUID(),
            patientId: clinic.patientId,
            fromDoctorId: clinic.doctorId,
            toDoctorId: doctorId,
            appointmentId: liveAppointmentId,
            status: "ACCEPTED",
            reason: "second opinion",
            initiatedByMembershipId: clinic.membershipId,
            decidedByMembershipId: membershipId,
            decidedAt: new Date(),
          }),
        });
      });

      const before = await countSensitiveReads();

      const response = await get(`/appointments/${liveAppointmentId}/visit`, token);
      expect(response.status).toBe(200);
      const visit = (await response.json()) as { diagnosis: string };
      expect(visit.diagnosis).toBe(SENTINELS.diagnosis);

      // A cross-doctor read that was served is a cross-doctor read that was recorded.
      expect(await countSensitiveReads()).toBe(before + 1);
    });

    test("a colleague with no grant is refused, even standing in the same clinic", async () => {
      const { token } = await colleague();
      const response = await get(`/appointments/${liveAppointmentId}/visit`, token);
      expect(response.status).toBe(409);
    });
  });

  describe("the boundaries", () => {
    /** `PHASE-4.md` Q13: a route returning clinical content owes a 403-at-the-guard test. */
    test("a reception token is refused at the guard", async () => {
      const response = await get(`/appointments/${liveAppointmentId}/visit`, receptionToken);
      expect(response.status).toBe(403);
      const text = await response.text();
      for (const sentinel of Object.values(SENTINELS)) expect(text).not.toContain(sentinel);
    });

    test("another tenant's appointment is 404, not 409 or 403", async () => {
      // 403 or 409 would both confirm the record exists (CLAUDE.md).
      const response = await get(`/appointments/${liveAppointmentId}/visit`, otherTenantDoctorToken);
      expect(response.status).toBe(404);
    });

    test("an appointment that never existed is 404", async () => {
      expect((await get(`/appointments/${randomUUID()}/visit`, doctorToken)).status).toBe(404);
    });

    test("a malformed id is refused before anything is looked up", async () => {
      expect((await get(`/appointments/not-a-uuid/visit`, doctorToken)).status).toBe(400);
    });
  });

  describe("revisions", () => {
    /**
     * Q2: the revision history is clinical context, not audit trivia.
     *
     * It is asserted **present and empty**, not merely absent-and-fine: nothing writes
     * `visit_revisions` until Q6's amendment flow exists, so an empty array is the correct answer
     * today. The Definition of Done box stays unticked until something has written a row and this
     * has read it back — an empty list proves the field is wired, not that the feature works.
     */
    test("the field is present, and empty until the amendment flow exists", async () => {
      const visit = (await (
        await get(`/appointments/${liveAppointmentId}/visit`, doctorToken)
      ).json()) as { revisions: unknown[] };

      expect(Array.isArray(visit.revisions)).toBe(true);
      expect(visit.revisions).toHaveLength(0);
    });
  });

  describe("attachments render on this screen, so the payload carries them", () => {
    const attach = async (fileName: string, visitAppointmentId: string): Promise<number> => {
      const visitId = await withTenant(clinic.tenantId, actorFor(clinic.userId), (tx) =>
        tx.visit
          .findFirstOrThrow({ where: { appointmentId: visitAppointmentId }, select: { id: true } })
          .then((v) => v.id),
      );
      const form = new FormData();
      form.append("file", new Blob([new Uint8Array(PDF_BYTES)], { type: "application/pdf" }), fileName);
      form.append("category", "LAB");
      form.append("visitId", visitId);
      const response = await fetch(`${baseUrl}/patients/${clinic.patientId}/attachments`, {
        method: "POST",
        headers: { authorization: `Bearer ${doctorToken}` },
        body: form,
      });
      return response.status;
    };

    test("attachments filed against the visit come back as metadata", async () => {
      expect(await attach("تحليل.pdf", liveAppointmentId)).toBe(201);

      const visit = (await (
        await get(`/appointments/${liveAppointmentId}/visit`, doctorToken)
      ).json()) as { attachments: { fileName: string; mimeType: string; sizeBytes: number }[] };

      expect(visit.attachments).toHaveLength(1);
      expect(visit.attachments[0]).toMatchObject({
        fileName: "تحليل.pdf",
        mimeType: "application/pdf",
        sizeBytes: PDF_BYTES.byteLength,
      });
    });

    test("the payload carries no bytes and no storage key", async () => {
      const text = await (await get(`/appointments/${liveAppointmentId}/visit`, doctorToken)).text();
      expect(text).not.toContain("storageKey");
      expect(text).not.toContain("%PDF");
      expect(text).not.toContain(storageRoot);
    });
  });
});
