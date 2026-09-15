import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { ValidationPipe } from "@nestjs/common";
import { APP_INTERCEPTOR, NestFactory } from "@nestjs/core";
import { Module } from "@nestjs/common";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { ActorContextInterceptor } from "../../src/common/actor-context.interceptor.ts";
import { issueAccessToken } from "../../src/modules/auth/jwt.ts";
import { PatientsController } from "../../src/modules/patients/patients.controller.ts";
import { createPatient, getPatient } from "../../src/modules/patients/patients.service.ts";
import { actorFor, type ClinicFixture, seedClinic, teardownClinic } from "./fixtures.ts";

/**
 * The patients HTTP surface, and the item that has been open since Phase 1.
 *
 * ## Cross-tenant access returns 404, not 403
 *
 * PHASE-1.md §2b carried this convention forward for "the first real resource controller". The data
 * layer half was proven in Phase 1 — a cross-tenant lookup resolves to `null`, never to another
 * tenant's row — but "returns 404" is a statement about an HTTP response, and until now there was
 * no HTTP response to observe.
 *
 * The assertions below are deliberately about **indistinguishability**, not just about the status
 * code. A 404 that arrived by a different route than a genuinely-missing record — a slower one, a
 * differently-worded one — would still leak the fact that the record exists, which is the entire
 * thing the convention prevents. So the test compares tenant B's real patient against a UUID that
 * has never existed and requires the two answers to be identical.
 */

@Module({
  controllers: [PatientsController],
  providers: [{ provide: APP_INTERCEPTOR, useClass: ActorContextInterceptor }],
})
class PatientsTestModule {}

describe("patients over HTTP", () => {
  let app: NestExpressApplication;
  let baseUrl: string;
  let clinicA: ClinicFixture;
  let clinicB: ClinicFixture;
  let tokenA: string;
  let patientInB: string;

  beforeAll(async () => {
    clinicA = await seedClinic();
    clinicB = await seedClinic();

    // A real patient in clinic B, created through the service so it is a genuine row.
    const created = await createPatient(
      { tenantId: clinicB.tenantId, actor: actorFor(clinicB.userId) },
      { fullNameAr: "مريض العيادة الأخرى", phoneE164: "+201090000001", relationshipToContact: "SELF" },
    );
    patientInB = created.id;

    // Clinic A's fixture patient is named "Test Patient" -- Latin -- so an Arabic query would find
    // nothing and the search assertions below would pass vacuously.
    await createPatient(
      { tenantId: clinicA.tenantId, actor: actorFor(clinicA.userId) },
      { fullNameAr: "مريض العيادة الأولى", phoneE164: "+201090000002", relationshipToContact: "SELF" },
    );

    app = await NestFactory.create<NestExpressApplication>(PatientsTestModule, { logger: false });
    app.set("trust proxy", 1);
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    await app.listen(0, "127.0.0.1");
    baseUrl = `http://127.0.0.1:${((app.getHttpServer() as Server).address() as AddressInfo).port}`;

    tokenA = await issueAccessToken({
      sub: clinicA.userId,
      membershipId: randomUUID(),
      tenantId: clinicA.tenantId,
      role: "RECEPTIONIST",
    });
  });

  afterAll(async () => {
    await app?.close();
    await teardownClinic(clinicA);
    await teardownClinic(clinicB);
  });

  async function get(path: string, token = tokenA): Promise<{ status: number; body: unknown }> {
    const response = await fetch(`${baseUrl}${path}`, { headers: { authorization: `Bearer ${token}` } });
    const text = await response.text();
    return { status: response.status, body: text.length > 0 ? JSON.parse(text) : null };
  }

  describe("the cross-tenant 404", () => {
    test("a patient in another tenant returns 404", async () => {
      const reply = await get(`/patients/${patientInB}`);
      expect(reply.status).toBe(404);
    });

    test("it is INDISTINGUISHABLE from a patient that never existed", async () => {
      // The assertion that matters. A different status, a different message, or a different shape
      // would confirm the record exists -- which is precisely what a 403 would have done, and why
      // there is no ownership check in the controller.
      const otherTenant = await get(`/patients/${patientInB}`);
      const neverExisted = await get(`/patients/${randomUUID()}`);
      expect(otherTenant).toEqual(neverExisted);
    });

    test("the row is genuinely there, so the 404 is not a missing fixture", async () => {
      // Without this, both requests above would 404 because the patient did not exist at all, and
      // the test would pass while proving nothing.
      const fromOwner = await getPatient({ tenantId: clinicB.tenantId, actor: actorFor(clinicB.userId) }, patientInB);
      expect(fromOwner?.id).toBe(patientInB);
    });

    test("no response anywhere in this surface is a 403", async () => {
      // A 403 would mean an ownership check had been introduced -- which requires first reading a
      // row the caller is not entitled to see.
      for (const path of [`/patients/${patientInB}`, `/patients/${patientInB}/visits`, `/patients/${randomUUID()}`]) {
        expect((await get(path)).status).not.toBe(403);
      }
    });

    test("visit history for another tenant's patient is 404, not an empty list", async () => {
      // An empty list would be a different wrong answer: it asserts "this patient has no visits",
      // which is a statement about a patient the caller cannot see.
      const reply = await get(`/patients/${patientInB}/visits`);
      expect(reply.status).toBe(404);
      expect(reply.body).not.toEqual([]);
    });
  });

  describe("ordinary access still works", () => {
    test("a patient in the caller's own tenant is returned", async () => {
      const reply = await get(`/patients/${clinicA.patientId}`);
      expect(reply.status).toBe(200);
      expect((reply.body as { id: string }).id).toBe(clinicA.patientId);
    });

    test("search finds a patient in the caller's tenant and never one from another", async () => {
      const reply = await get(`/patients?q=${encodeURIComponent("مريض")}`);
      expect(reply.status).toBe(200);
      const ids = (reply.body as Array<{ id: string }>).map((row) => row.id);
      expect(ids).not.toContain(patientInB);
    });

    test("search results carry the three fields D19 requires for a human to choose safely", async () => {
      // D19 accepts that its normalisation merges some genuinely different names, and that is
      // survivable ONLY because a human sees the real name with a phone number and date of birth.
      // Dropping any of the three from this shape makes those rules unsafe.
      const reply = await get(`/patients?q=${encodeURIComponent("مريض")}`);
      const first = (reply.body as Array<Record<string, unknown>>)[0];
      expect(first).toBeDefined();
      expect(Object.keys(first ?? {})).toEqual(
        expect.arrayContaining(["fullNameAr", "phoneE164", "dateOfBirth"]),
      );
    });

    test("visit history returns metadata and no clinical content", async () => {
      // CLAUDE.md: diagnosis, examination, plan and notes are doctor-only and must live behind a
      // separate endpoint, never be filtered out of this one.
      const reply = await get(`/patients/${clinicA.patientId}/visits`);
      expect(reply.status).toBe(200);
      const serialised = JSON.stringify(reply.body);
      for (const clinical of ["diagnosis", "examination", "treatmentPlan", "doctorNotes", "complaint"]) {
        expect(serialised).not.toContain(clinical);
      }
    });
  });

  describe("search finds one word of a name, which is how people actually search", () => {
    test("a single given name matches a three-part patient", async () => {
      // The case that caught `similarity()` being the wrong operator. Measured on real data:
      //   similarity('مريض العيادة الأولى', 'مريض')      = 0.28  -> below threshold, NO match
      //   word_similarity('مريض', 'مريض العيادة الأولى') = 1.00
      // A receptionist typing a first name is the ordinary case, and with the whole-string operator
      // it returned nothing for any name of three parts or more. D19 says what happens then: she
      // concludes the patient is not registered and creates a duplicate.
      const reply = await get(`/patients?q=${encodeURIComponent("مريض")}`);
      expect(reply.status).toBe(200);
      expect((reply.body as unknown[]).length).toBeGreaterThan(0);
    });

    test("a middle word of the name matches too", async () => {
      // Not just a prefix: word_similarity looks at any portion, which is what makes searching by
      // family name work when the receptionist does not know the given name.
      const reply = await get(`/patients?q=${encodeURIComponent("العيادة")}`);
      expect((reply.body as unknown[]).length).toBeGreaterThan(0);
    });

    test("an unrelated word still matches nothing, so the threshold is doing work", async () => {
      // Without this, lowering the threshold to zero would pass every test above.
      const reply = await get(`/patients?q=${encodeURIComponent("زرافة")}`);
      expect(reply.body).toEqual([]);
    });
  });

  describe("the guards are actually on", () => {
    test("no token is 401", async () => {
      const response = await fetch(`${baseUrl}/patients/${clinicA.patientId}`);
      expect(response.status).toBe(401);
    });

    test("every role may use these endpoints, so this controller has no 403 case at all", async () => {
      // Worth recording rather than assuming. The first draft of this test asserted that a DOCTOR
      // would get 403 on patient search -- a matrix fact I had not checked, and it is false:
      // §8 gives patients.write and visits.readIndex to ALL FOUR roles. Reception registers
      // patients, and visit *metadata* is deliberately visible to everyone, with only the clinical
      // content restricted (CLAUDE.md).
      //
      // So there is no 403 to demonstrate here, and the guard's presence is proven by the routes
      // that will have one -- not by inventing a denial this controller does not have. Asserting
      // all four roles succeed is the honest version, and it would fail if someone tightened a
      // capability without noticing which roles a clinic actually needs.
      for (const role of ["OWNER", "ADMIN", "DOCTOR", "RECEPTIONIST"] as const) {
        const token = await issueAccessToken({
          sub: clinicA.userId,
          membershipId: randomUUID(),
          tenantId: clinicA.tenantId,
          role,
        });
        expect({ role, status: (await get(`/patients?q=x`, token)).status }).toEqual({ role, status: 200 });
      }
    });
  });
});
