import { ThrottlingModule } from "../../src/common/throttling.module.ts";
import { randomUUID } from "node:crypto";
import { generateFixturePhone } from "../fixture-phone.ts";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Module, ValidationPipe } from "@nestjs/common";
import { APP_INTERCEPTOR, NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { ActorContextInterceptor } from "../../src/common/actor-context.interceptor.ts";
import { issueAccessToken } from "../../src/modules/auth/jwt.ts";
import { ClinicalController } from "../../src/modules/clinical/clinical.controller.ts";
import { InsuranceController } from "../../src/modules/insurance/insurance.controller.ts";
import { PatientsController } from "../../src/modules/patients/patients.controller.ts";
import { latinSearchKey } from "../../src/modules/patients/domain/transliterate.ts";
import { prisma } from "../../src/prisma/client.ts";
import { injected } from "../../src/prisma/injected.ts";
import { withTenant } from "../../src/prisma/with-tenant.ts";
import { actorFor, createTestUser, seedClinic, teardownClinic, type ClinicFixture } from "./fixtures.ts";

/**
 * The patient detail screen's backend. `PHASE-3.md` Q18.
 *
 * The founder asked for two things to be **proven**, not implemented, and they are the two
 * `describe` blocks at the bottom of this file. Everything above them is the setup those proofs
 * need in order to assert anything at all.
 *
 * The setup matters more than usual here. "Reception cannot retrieve clinical content" is trivially
 * true of a database with no clinical content in it, and a test that passes for that reason is the
 * vacuous guard this project keeps finding. So a real visit is written with a real diagnosis, a
 * doctor token is used to prove that content is genuinely reachable, and only then is reception
 * shown to be unable to reach it.
 */
@Module({
  // A rate-limited route lives here (4b), so its guard needs the throttler options in scope.
  imports: [ThrottlingModule],
  controllers: [PatientsController, InsuranceController, ClinicalController],
  providers: [{ provide: APP_INTERCEPTOR, useClass: ActorContextInterceptor }],
})
class PatientDetailTestModule {}

/** Distinctive enough that finding it anywhere in a payload is unambiguous. */
const DIAGNOSIS = "التهاب الجيوب الأنفية الحاد";
const DOCTOR_NOTES = "SENTINEL-DOCTOR-NOTES-must-never-reach-reception";
const EXAMINATION = "SENTINEL-EXAMINATION-must-never-reach-reception";

describe("patient detail — Q18", () => {
  let app: NestExpressApplication;
  let baseUrl: string;
  let clinic: ClinicFixture;

  let receptionToken: string;
  let doctorToken: string;
  let patientId: string;
  let appointmentId: string;

  const api = async (
    method: string,
    path: string,
    token: string,
    body?: unknown,
  ): Promise<{ status: number; text: string; json: Record<string, unknown> }> => {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return {
      status: response.status,
      text,
      json: text.length === 0 ? {} : (JSON.parse(text) as Record<string, unknown>),
    };
  };

  beforeAll(async () => {
    clinic = await seedClinic();

    await withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) => {
      // A household contact, because a policy hangs off `contacts` rather than `patients`.
      const contactId = randomUUID();
      await tx.contact.create({
        data: injected({ id: contactId, phoneE164: generateFixturePhone("+2011") }),
      });

      patientId = randomUUID();
      await tx.patient.create({
        data: injected({
          id: patientId,
          contactId,
          fullNameAr: "محمد أحمد",
          nameSearchLatin: latinSearchKey("محمد أحمد", null),
          phoneE164: generateFixturePhone(),
          relationshipToContact: "SELF",
          status: "ACTIVE",
        }),
      });

      appointmentId = randomUUID();
      const start = new Date("2026-09-02T09:00:00Z");
      await tx.appointment.create({
        data: injected({
          id: appointmentId,
          patientId,
          doctorId: clinic.doctorId,
          serviceId: clinic.serviceId,
          scheduledStart: start,
          scheduledEnd: new Date(start.getTime() + 30 * 60_000),
          // IN_CONSULTATION, not COMPLETED, and the distinction is load-bearing for this file.
          // `clinical-history` is gated on `own patient && PRESENT` (clinical.access.ts), so with a
          // closed appointment even the treating doctor is refused — and the non-vacuity test below
          // would then pass for the wrong reason, proving only that nobody can read a diagnosis.
          status: "IN_CONSULTATION",
          source: "RECEPTION",
          arrivedAt: start,
          waitingStartedAt: start,
          consultationStartedAt: start,
          createdBy: clinic.userId,
          updatedBy: clinic.userId,
        }),
      });

      // The clinical content the proof is about. Without this row the negative assertions below
      // would pass against an empty database and prove nothing whatsoever.
      await tx.visit.create({
        data: injected({
          id: randomUUID(),
          patientId,
          doctorId: clinic.doctorId,
          appointmentId,
          complaint: "صداع",
          examination: EXAMINATION,
          diagnosis: DIAGNOSIS,
          doctorNotes: DOCTOR_NOTES,
          status: "COMPLETED",
          completedAt: new Date(start.getTime() + 20 * 60_000),
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

    app = await NestFactory.create<NestExpressApplication>(PatientDetailTestModule, { logger: false });
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
   * PROOF 1. The founder, by name: "a reception token cannot retrieve clinical content through this
   * route."
   */
  describe("a reception token cannot retrieve clinical content through this route", () => {
    test("the content genuinely exists and a doctor can read it — otherwise this proves nothing", async () => {
      // Non-vacuity, and the load-bearing test of the block. Every assertion below is satisfied by
      // a database containing no diagnosis at all, so this one has to fail if the content is not
      // really there and really reachable.
      //
      // `clinical-history`, not `clinical-summary`: the summary is the *safety* view — allergies,
      // medication, treatment plans and visit dates — and deliberately carries no diagnosis. That
      // is a real distinction in `clinical.service.ts`, and writing this test against the wrong one
      // is how it would have silently proved nothing.
      const history = await api("GET", `/appointments/${appointmentId}/clinical-history`, doctorToken);
      expect(history.status).toBe(200);
      expect(history.text).toContain(DIAGNOSIS);
      expect(history.text).toContain(DOCTOR_NOTES);
    });

    test("the profile carries no clinical content", async () => {
      const profile = await api("GET", `/patients/${patientId}`, receptionToken);
      expect(profile.status).toBe(200);
      // Searched as raw text, not by key: field-by-field assertions pass a nested object through.
      for (const secret of [DIAGNOSIS, DOCTOR_NOTES, EXAMINATION]) {
        expect(profile.text).not.toContain(secret);
      }
    });

    test("visit history is metadata only", async () => {
      const visits = await api("GET", `/patients/${patientId}/visits`, receptionToken);
      expect(visits.status).toBe(200);
      // The row exists and is listed -- so this is not passing because the list is empty.
      expect(Array.isArray(visits.json) ? visits.json : []).toHaveLength(1);
      for (const secret of [DIAGNOSIS, DOCTOR_NOTES, EXAMINATION]) {
        expect(visits.text).not.toContain(secret);
      }
    });

    test("the insurance block carries no clinical content", async () => {
      const insurance = await api("GET", `/patients/${patientId}/insurance`, receptionToken);
      expect(insurance.status).toBe(200);
      for (const secret of [DIAGNOSIS, DOCTOR_NOTES, EXAMINATION]) {
        expect(insurance.text).not.toContain(secret);
      }
    });

    test("the clinical endpoints refuse reception outright, at the guard", async () => {
      // Refused before any handler runs -- `visits.readContent` is NONE for RECEPTIONIST. Not a
      // filtered response: reception never reaches the code that reads a diagnosis, which is
      // CLAUDE.md's "separate endpoints and separate DTOs, never filtering fields out of one".
      const summary = await api("GET", `/appointments/${appointmentId}/clinical-summary`, receptionToken);
      const history = await api("GET", `/appointments/${appointmentId}/clinical-history`, receptionToken);
      expect(summary.status).toBe(403);
      expect(history.status).toBe(403);
    });

    test("editing a patient does not echo clinical content back", async () => {
      const updated = await api("PATCH", `/patients/${patientId}`, receptionToken, { address: "12 Nile St" });
      expect(updated.status).toBe(200);
      for (const secret of [DIAGNOSIS, DOCTOR_NOTES, EXAMINATION]) {
        expect(updated.text).not.toContain(secret);
      }
    });
  });

  /**
   * PROOF 2. The founder, by name: "editing full_name_ar recomputes name_search_latin, not just on
   * create."
   *
   * This is the one that could not previously be written, because until this branch there was no
   * update path at all — which is exactly why the omission would have been easy to make and
   * invisible afterwards. D19 records the cost: search stops finding a renamed patient, reception
   * concludes they are not registered, and creates a duplicate that splits the medical history
   * permanently.
   */
  describe("editing full_name_ar recomputes name_search_latin", () => {
    const readLatin = async (id: string): Promise<string | null> => {
      const rows = await withTenant(clinic.tenantId, actorFor(clinic.userId), (tx) =>
        tx.patient.findMany({ where: { id }, select: { nameSearchLatin: true } }),
      );
      return rows[0]?.nameSearchLatin ?? null;
    };

    test("the stored key changes, and matches the new name's transliteration", async () => {
      const id = randomUUID();
      await withTenant(clinic.tenantId, actorFor(clinic.userId), (tx) =>
        tx.patient.create({
          data: injected({
            id,
            fullNameAr: "خالد إبراهيم",
            nameSearchLatin: latinSearchKey("خالد إبراهيم", null),
            phoneE164: `+2012${id.replace(/-/g, "").slice(0, 7)}`,
            relationshipToContact: "SELF",
            status: "ACTIVE",
          }),
        }),
      );

      const before = await readLatin(id);
      expect(before).toBe(latinSearchKey("خالد إبراهيم", null));

      const renamed = await api("PATCH", `/patients/${id}`, receptionToken, { fullNameAr: "منصور عبد الله" });
      expect(renamed.status).toBe(200);

      const after = await readLatin(id);
      expect(after).not.toBe(before);
      expect(after).toBe(latinSearchKey("منصور عبد الله", null));
    });

    test("search finds the patient by the new spelling and no longer by the old", async () => {
      // The assertion that describes the actual user-visible failure. A stale key means the desk
      // searches the corrected name, finds nothing, and registers the patient a second time.
      //
      // The search terms are **derived from `latinSearchKey`, never guessed.** D19's transliterator
      // is a table of names, not a general algorithm: it returns `null` for anything it does not
      // recognise, and the first draft of this test searched a hand-written spelling of a name that
      // maps to nothing at all — which fails while the code is correct, and would have been "fixed"
      // by weakening the assertion.
      const OLD_NAME = "خالد إبراهيم";
      const NEW_NAME = "منصور عبد الله";
      const firstToken = (name: string): string => (latinSearchKey(name, null) ?? "").split(" ")[0] ?? "";
      expect(firstToken(OLD_NAME)).not.toBe("");
      expect(firstToken(NEW_NAME)).not.toBe("");

      const id = randomUUID();
      await withTenant(clinic.tenantId, actorFor(clinic.userId), (tx) =>
        tx.patient.create({
          data: injected({
            id,
            fullNameAr: OLD_NAME,
            nameSearchLatin: latinSearchKey(OLD_NAME, null),
            phoneE164: `+2013${id.replace(/-/g, "").slice(0, 7)}`,
            relationshipToContact: "SELF",
            status: "ACTIVE",
          }),
        }),
      );

      const found = async (query: string): Promise<boolean> => {
        const reply = await api("GET", `/patients?q=${encodeURIComponent(query)}`, receptionToken);
        const results = (reply.json as unknown as { id: string }[]) ?? [];
        return Array.isArray(results) && results.some((row) => row.id === id);
      };

      expect(await found(firstToken(OLD_NAME))).toBe(true);

      await api("PATCH", `/patients/${id}`, receptionToken, { fullNameAr: NEW_NAME });

      // Findable by the corrected name...
      expect(await found(firstToken(NEW_NAME))).toBe(true);
      // ...and no longer by the wrong one, which is the half a stale key would silently keep.
      expect(await found(firstToken(OLD_NAME))).toBe(false);
    });

    test("changing only the English name still folds the unchanged Arabic name back in", async () => {
      // Computing the key from the patch alone would silently drop the Arabic half here.
      const id = randomUUID();
      await withTenant(clinic.tenantId, actorFor(clinic.userId), (tx) =>
        tx.patient.create({
          data: injected({
            id,
            fullNameAr: "ياسين حسن",
            nameSearchLatin: latinSearchKey("ياسين حسن", null),
            phoneE164: `+2014${id.replace(/-/g, "").slice(0, 7)}`,
            relationshipToContact: "SELF",
            status: "ACTIVE",
          }),
        }),
      );

      await api("PATCH", `/patients/${id}`, receptionToken, { fullNameEn: "Yassin Hassan" });

      const after = await readLatin(id);
      expect(after).toBe(latinSearchKey("ياسين حسن", "Yassin Hassan"));
    });

    test("an edit that touches neither name leaves the key alone", async () => {
      const id = randomUUID();
      await withTenant(clinic.tenantId, actorFor(clinic.userId), (tx) =>
        tx.patient.create({
          data: injected({
            id,
            fullNameAr: "نور الهدى",
            nameSearchLatin: latinSearchKey("نور الهدى", null),
            phoneE164: `+2015${id.replace(/-/g, "").slice(0, 7)}`,
            relationshipToContact: "SELF",
            status: "ACTIVE",
          }),
        }),
      );

      const before = await readLatin(id);
      await api("PATCH", `/patients/${id}`, receptionToken, { address: "5 Tahrir Sq" });
      expect(await readLatin(id)).toBe(before);
    });
  });

  /** The insurance block itself — active prominent, lapsed kept as history rather than hidden. */
  describe("insurance", () => {
    test("an active policy is returned as active, with everything reception needs at the desk", async () => {
      const created = await api("POST", `/patients/${patientId}/insurance`, receptionToken, {
        insurerName: "MedRight Egypt",
        policyNumber: "MR-889231",
        policyholderName: "أحمد محمود",
        validFrom: "2026-01-01",
        validTo: "2099-12-31",
        relationshipToPolicyholder: "CHILD",
      });
      expect(created.status).toBe(201);

      const coverage = await api("GET", `/patients/${patientId}/insurance`, receptionToken);
      const active = coverage.json["active"] as Record<string, unknown>[];
      expect(active).toHaveLength(1);
      expect(active[0]).toMatchObject({
        insurerName: "MedRight Egypt",
        policyNumber: "MR-889231",
        policyholderName: "أحمد محمود",
        relationshipToPolicyholder: "CHILD",
        validFrom: "2026-01-01",
        validTo: "2099-12-31",
        standing: "ACTIVE",
      });
    });

    test("a lapsed policy is kept and reported as lapsed, not dropped", async () => {
      // The founder's ruling: "a patient whose cover lapsed last month is a conversation reception
      // needs to have, and if the screen only shows 'no active policy' they'll assume there never
      // was one." So the API has to return it, not merely the screen render it.
      await api("POST", `/patients/${patientId}/insurance`, receptionToken, {
        insurerName: "OldCover Co",
        policyNumber: "OC-100",
        policyholderName: "أحمد محمود",
        validFrom: "2020-01-01",
        validTo: "2021-12-31",
        relationshipToPolicyholder: "CHILD",
      });

      const coverage = await api("GET", `/patients/${patientId}/insurance`, receptionToken);
      const lapsed = coverage.json["lapsed"] as Record<string, unknown>[];
      expect(lapsed.some((row) => row["policyNumber"] === "OC-100")).toBe(true);
      expect(lapsed.every((row) => row["standing"] === "LAPSED")).toBe(true);
    });

    test("an end date before the start date is refused with a code, not a constraint error", async () => {
      const bad = await api("POST", `/patients/${patientId}/insurance`, receptionToken, {
        insurerName: "Backwards Ltd",
        policyNumber: "BW-1",
        policyholderName: "أحمد محمود",
        validFrom: "2026-06-01",
        validTo: "2026-01-01",
        relationshipToPolicyholder: "SELF",
      });
      expect(bad.status).toBe(422);
      // `code` and `params`, not a sentence -- the 2026-09-06 ruling. The client renders the
      // Arabic; asserting the English here would have pinned this test to wording that is no
      // longer on the wire at all.
      expect({ code: bad.json["code"], params: bad.json["params"] }).toEqual({
        code: "INVALID_WINDOW",
        params: {},
      });
    });

    test("a second patient on the same card reuses one policy row", async () => {
      // One phone, several patients, one policy -- so a corrected policy number is corrected once.
      const siblingId = randomUUID();
      const contact = await withTenant(clinic.tenantId, actorFor(clinic.userId), (tx) =>
        tx.patient.findUniqueOrThrow({ where: { id: patientId }, select: { contactId: true } }),
      );
      await withTenant(clinic.tenantId, actorFor(clinic.userId), (tx) =>
        tx.patient.create({
          data: injected({
            id: siblingId,
            contactId: contact.contactId,
            fullNameAr: "سارة محمود",
            phoneE164: generateFixturePhone(),
            relationshipToContact: "SIBLING",
            status: "ACTIVE",
          }),
        }),
      );

      await api("POST", `/patients/${siblingId}/insurance`, receptionToken, {
        insurerName: "MedRight Egypt",
        policyNumber: "MR-889231",
        policyholderName: "أحمد محمود",
        validFrom: "2026-01-01",
        validTo: "2099-12-31",
        relationshipToPolicyholder: "CHILD",
      });

      const policies = await withTenant(clinic.tenantId, actorFor(clinic.userId), (tx) =>
        tx.insurancePolicy.findMany({ where: { policyNumber: "MR-889231" }, select: { id: true } }),
      );
      expect(policies).toHaveLength(1);
    });

    test("another tenant's patient is 404, not an empty coverage list", async () => {
      // An empty list would assert "this patient has no insurance", which is a statement about a
      // patient the caller cannot see. Same reasoning as the visits endpoint.
      const other = await seedClinic();
      try {
        const reply = await api("GET", `/patients/${other.patientId}/insurance`, receptionToken);
        expect(reply.status).toBe(404);
      } finally {
        await teardownClinic(other);
      }
    });
  });

  /**
   * Q18: **outstanding balance is read from `remaining_minor`, never recomputed.**
   *
   * `PHASE-3.md` asks for this to be proven the way this project proves guards: change
   * `amount_paid_minor` directly and confirm the figure moves with the generated column. A service
   * doing its own `due - paid` would pass every ordinary test and drift the first time a payment is
   * adjusted by anything that is not that code path, which is the whole of D7.
   */
  describe("outstanding balance", () => {
    /**
     * Phase 5 PR 5 split the invoice from the receipt, so "what is owed" is now a property of the
     * charge and not of the payment row. The fixture therefore writes what a real visit writes: a
     * visit, its charge, and a receipt settling part of it.
     */
    const payFor = async (_unused: string, due: number, paid: number): Promise<string> => {
      const id = randomUUID();
      await withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) => {
        // Its own appointment: a partial unique index allows one COMPLETED visit per appointment,
        // and the shared fixture appointment already has one.
        const appointment = await tx.appointment.create({
          data: injected({
            id: randomUUID(),
            patientId,
            doctorId: clinic.doctorId,
            serviceId: clinic.serviceId,
            scheduledStart: new Date("2027-02-01T09:00:00Z"),
            scheduledEnd: new Date("2027-02-01T09:30:00Z"),
            status: "COMPLETED",
            source: "RECEPTION",
            createdBy: clinic.userId,
            updatedBy: clinic.userId,
            allowOverlap: true,
          }),
          select: { id: true },
        });
        const appointmentId = appointment.id;
        const visit = await tx.visit.create({
          data: injected({
            id: randomUUID(),
            patientId,
            doctorId: clinic.doctorId,
            appointmentId,
            status: "COMPLETED",
            createdBy: clinic.userId,
          }),
          select: { id: true },
        });
        const charge = await tx.visitCharge.create({
          data: injected({
            id: randomUUID(),
            visitId: visit.id,
            patientId,
            subtotalMinor: due,
          }),
          select: { id: true },
        });
        await tx.payment.create({
          data: injected({
            id,
            patientId,
            appointmentId,
            visitId: visit.id,
            chargeId: charge.id,
            amountMinor: paid,
            method: "CASH",
            status: paid >= due ? "PAID" : "PARTIAL",
          }),
        });
      });
      return id;
    };

    const balance = async (): Promise<Record<string, unknown>> =>
      (await api("GET", `/patients/${patientId}/balance`, receptionToken)).json;

    test("no payment rows reads as nothing owed, and says so is distinguishable", async () => {
      const before = await balance();
      // Zero owed and zero recorded are the same answer to "what is owed" and different answers to
      // "has anything been billed" -- hence paymentCount beside it.
      expect(before).toEqual({ outstandingMinor: 0, paymentCount: 0 });
    });

    test("it sums the charge balances, and moves when a receipt is changed underneath it", async () => {
      const paymentId = await payFor(appointmentId, 30000, 10000);

      // 30000 charged, 10000 received -> the view computes 20000.
      expect(await balance()).toEqual({ outstandingMinor: 20000, paymentCount: 1 });

      // The proof. Nothing in the API is told about this; the view recomputes itself.
      await withTenant(clinic.tenantId, actorFor(clinic.userId), (tx) =>
        tx.payment.update({ where: { id: paymentId }, data: { amountMinor: 25000 } }),
      );

      expect(await balance()).toEqual({ outstandingMinor: 5000, paymentCount: 1 });

      // And to zero, so a fully-paid patient is not left showing a stale figure.
      await withTenant(clinic.tenantId, actorFor(clinic.userId), (tx) =>
        tx.payment.update({ where: { id: paymentId }, data: { amountMinor: 30000 } }),
      );
      expect(await balance()).toEqual({ outstandingMinor: 0, paymentCount: 1 });
    });

    test("another tenant's patient is 404, not a confident zero", async () => {
      // "This patient owes nothing" is a statement about a patient the caller may not be entitled
      // to know exists.
      const other = await seedClinic();
      try {
        const reply = await api("GET", `/patients/${other.patientId}/balance`, receptionToken);
        expect(reply.status).toBe(404);
      } finally {
        await teardownClinic(other);
      }
    });
  });

  /** Q18: appointment history — scheduling facts, and deliberately not the visits list. */
  describe("appointment history", () => {
    test("it lists the patient's appointments, so the leak sweep over it is not vacuous", async () => {
      const reply = await api("GET", `/patients/${patientId}/appointments`, receptionToken);
      expect(reply.status).toBe(200);
      const rows = reply.json as unknown as { id: string; status: string }[];
      expect(Array.isArray(rows) ? rows.length : 0).toBeGreaterThan(0);
      expect(rows.some((row) => row.id === appointmentId)).toBe(true);
    });

    test("it carries no clinical content, including the complaint the patient gave", async () => {
      // complaint_summary sits on `appointments` and is reachable by reception at this route, so
      // its absence is a choice this test holds in place rather than an accident of the schema.
      const reply = await api("GET", `/patients/${patientId}/appointments`, receptionToken);
      for (const secret of [DIAGNOSIS, DOCTOR_NOTES, EXAMINATION, "صداع"]) {
        expect(reply.text).not.toContain(secret);
      }
    });

    test("it shows a cancelled appointment, which the visits list cannot", async () => {
      // The reason this is not just /visits: a cancelled appointment produces no visit and would
      // vanish there, while being exactly what reception needs when a patient says "but I came".
      const cancelledId = randomUUID();
      const start = new Date("2026-07-14T09:00:00Z");
      await withTenant(clinic.tenantId, actorFor(clinic.userId), (tx) =>
        tx.appointment.create({
          data: injected({
            id: cancelledId,
            patientId,
            doctorId: clinic.doctorId,
            serviceId: clinic.serviceId,
            scheduledStart: start,
            scheduledEnd: new Date(start.getTime() + 30 * 60_000),
            status: "CANCELLED",
            source: "RECEPTION",
            cancellationReason: "المريض اعتذر",
            createdBy: clinic.userId,
            updatedBy: clinic.userId,
          }),
        }),
      );

      const appointments = (await api("GET", `/patients/${patientId}/appointments`, receptionToken))
        .json as unknown as { id: string }[];
      expect(appointments.some((row) => row.id === cancelledId)).toBe(true);

      const visits = (await api("GET", `/patients/${patientId}/visits`, receptionToken))
        .json as unknown as { id: string }[];
      expect(visits.some((row) => row.id === cancelledId)).toBe(false);
    });
  });
});
