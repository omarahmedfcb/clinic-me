import { ThrottlingModule } from "../../src/common/throttling.module.ts";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Module, ValidationPipe } from "@nestjs/common";
import { APP_INTERCEPTOR, NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { ActorContextInterceptor } from "../../src/common/actor-context.interceptor.ts";
import { issueAccessToken } from "../../src/modules/auth/jwt.ts";
import { PatientsController } from "../../src/modules/patients/patients.controller.ts";
import { prisma } from "../../src/prisma/client.ts";
import { injected } from "../../src/prisma/injected.ts";
import { withTenant } from "../../src/prisma/with-tenant.ts";
import { actorFor, seedClinic, teardownClinic, type ClinicFixture } from "./fixtures.ts";
import { generateFixturePhone } from "../fixture-phone.ts";

/**
 * The patient book — `PHASE-4.md`, ruled by the founder on 2026-09-03.
 *
 * His reason is the test's subject: *"reception answering a phone call about a balance should not
 * have to open a booking dialog and abandon it. That's the definition of working around the system,
 * and it's the behaviour that produces duplicate records."* Until this endpoint, the only way to
 * reach a patient not in today's queue was to start a booking and not finish it.
 *
 * ## Ordering is the feature, not a detail
 *
 * "Most recently seen" means the last appointment that actually happened. A patient with a booking
 * next Tuesday has not been seen, and ordering by appointments that have not happened yet would put
 * the future at the top of a list whose whole purpose is who was here recently. That distinction is
 * asserted directly below.
 *
 * Alphabetical was never an option: `SCHEMA-DECISIONS.md` D19 rules it out, because under
 * code-point ordering Latin sorts entirely before Arabic and a mixed list pins the handful of
 * English-named patients to the top and reads as a bug.
 */
@Module({
  // A rate-limited route lives here (4b), so its guard needs the throttler options in scope.
  imports: [ThrottlingModule],
  controllers: [PatientsController],
  providers: [{ provide: APP_INTERCEPTOR, useClass: ActorContextInterceptor }],
})
class PatientsTestModule {}

describe("the patient book", () => {
  let app: NestExpressApplication;
  let baseUrl: string;
  let clinicA: ClinicFixture;
  let clinicB: ClinicFixture;

  let ownerToken: string;
  let adminToken: string;
  let doctorToken: string;
  let receptionToken: string;

  /** Named so the assertions below read as statements about people, not about array indices. */
  const seenLongAgo = { id: randomUUID(), name: "سيدة قديمة", seenAt: new Date("2026-01-05T09:00:00Z") };
  const seenRecently = { id: randomUUID(), name: "سيدة حديثة", seenAt: new Date("2026-08-20T09:00:00Z") };
  const bookedButNotSeen = { id: randomUUID(), name: "مريض قادم", bookedFor: new Date("2027-06-01T09:00:00Z") };
  const neverSeen = { id: randomUUID(), name: "مريض جديد" };

  async function addPatient(fixture: ClinicFixture, id: string, fullNameAr: string): Promise<void> {
    await withTenant(fixture.tenantId, actorFor(fixture.userId), async (tx) => {
      await tx.patient.create({
        data: injected({
          id,
          fullNameAr,
          phoneE164: `+2011${id.replace(/-/g, "").slice(0, 8)}`,
          relationshipToContact: "SELF",
          status: "ACTIVE",
        }),
      });
    });
  }

  async function addAppointment(
    fixture: ClinicFixture,
    patientId: string,
    start: Date,
    status: "COMPLETED" | "BOOKED",
  ): Promise<void> {
    await withTenant(fixture.tenantId, actorFor(fixture.userId), async (tx) => {
      await tx.appointment.create({
        data: injected({
          patientId,
          doctorId: fixture.doctorId,
          serviceId: fixture.serviceId,
          scheduledStart: start,
          scheduledEnd: new Date(start.getTime() + 20 * 60_000),
          status,
          source: "RECEPTION",
          createdBy: fixture.userId,
          updatedBy: fixture.userId,
        }),
      });
    });
  }

  beforeAll(async () => {
    clinicA = await seedClinic();
    clinicB = await seedClinic();

    // Created in an order that is not the expected output order, so a passing assertion cannot be
    // insertion order wearing a sort's clothes.
    await addPatient(clinicA, neverSeen.id, neverSeen.name);
    await addPatient(clinicA, seenRecently.id, seenRecently.name);
    await addPatient(clinicA, bookedButNotSeen.id, bookedButNotSeen.name);
    await addPatient(clinicA, seenLongAgo.id, seenLongAgo.name);

    await addAppointment(clinicA, seenLongAgo.id, seenLongAgo.seenAt, "COMPLETED");
    await addAppointment(clinicA, seenRecently.id, seenRecently.seenAt, "COMPLETED");
    await addAppointment(clinicA, bookedButNotSeen.id, bookedButNotSeen.bookedFor, "BOOKED");

    app = await NestFactory.create<NestExpressApplication>(PatientsTestModule, { logger: false });
    app.set("trust proxy", 1);
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();
    await app.listen(0, "127.0.0.1");
    baseUrl = `http://127.0.0.1:${((app.getHttpServer() as Server).address() as AddressInfo).port}`;

    const tokenFor = (role: "OWNER" | "ADMIN" | "DOCTOR" | "RECEPTIONIST"): Promise<string> =>
      issueAccessToken({
        sub: clinicA.userId,
        membershipId: randomUUID(),
        tenantId: clinicA.tenantId,
        role,
      });

    [ownerToken, adminToken, doctorToken, receptionToken] = await Promise.all([
      tokenFor("OWNER"),
      tokenFor("ADMIN"),
      tokenFor("DOCTOR"),
      tokenFor("RECEPTIONIST"),
    ]);
  });

  afterAll(async () => {
    await app?.close();
    await teardownClinic(clinicA);
    await teardownClinic(clinicB);
    await prisma.$disconnect();
  });

  interface Page {
    patients: {
      id: string;
      fullNameAr: string;
      lastSeenAt: string | null;
      insurance: { insurerName: string; standing: string } | null;
    }[];
    total: number;
  }

  const get = (path: string, token: string): Promise<Response> =>
    fetch(`${baseUrl}${path}`, { headers: { authorization: `Bearer ${token}` } });

  const page = async (query: string, token: string = receptionToken): Promise<Page> => {
    const response = await get(`/patients/recent${query}`, token);
    expect(response.status).toBe(200);
    return (await response.json()) as Page;
  };

  /**
   * The insurance badge — ruled 2026-09-05, so reception can answer "is this one covered" from the
   * book without opening the patient.
   *
   * The standing is computed by the same `standingOf` the detail screen uses, against the clinic's
   * calendar day. What is tested here is the three states reaching the row correctly, and the
   * ordering rule that picks *which* policy gets badged when a patient holds more than one — a
   * patient may legitimately hold a government scheme and an employer's at once.
   */
  describe("the insurance badge", () => {
    const insured = { id: randomUUID(), name: "مريض مؤمَّن" };
    const lapsed = { id: randomUUID(), name: "مريض انتهى تأمينه" };
    const future = { id: randomUUID(), name: "مريض يبدأ لاحقًا" };
    const twoPolicies = { id: randomUUID(), name: "مريض بوثيقتين" };

    const givePolicy = async (
      patientId: string,
      insurerName: string,
      validFrom: string,
      validTo: string | null,
    ): Promise<void> => {
      await withTenant(clinicA.tenantId, actorFor(clinicA.userId), async (tx) => {
        // `insurance_policies.contact_id` references `contacts`, not `patients` -- a policy belongs
        // to the person who holds it, who may cover a household. The fixture patients carry no
        // contact, so one is made here rather than passing a patient id that happens to be a UUID.
        const contactId = randomUUID();
        await tx.contact.create({
          data: injected({
            id: contactId,
            phoneE164: generateFixturePhone(),
            whatsappOptIn: false,
          }),
        });
        const policyId = randomUUID();
        await tx.insurancePolicy.create({
          data: injected({
            id: policyId,
            contactId,
            insurerName,
            policyNumber: `POL-${insurerName}`,
            policyholderName: "حامل الوثيقة",
            validFrom: new Date(validFrom),
            validTo: validTo === null ? null : new Date(validTo),
          }),
        });
        await tx.patientInsurance.create({
          data: injected({
            id: randomUUID(),
            patientId,
            policyId,
            relationshipToPolicyholder: "SELF",
          }),
        });
      });
    };

    const badgeFor = async (id: string): Promise<{ insurerName: string; standing: string } | null> => {
      const body = await page("?limit=50");
      const row = body.patients.find((p) => p.id === id);
      expect(row).toBeDefined();
      return row?.insurance ?? null;
    };

    beforeAll(async () => {
      for (const p of [insured, lapsed, future, twoPolicies]) await addPatient(clinicA, p.id, p.name);
      await givePolicy(insured.id, "المصرية للتأمين", "2020-01-01", null);
      await givePolicy(lapsed.id, "مصر للتأمين", "2019-01-01", "2020-01-01");
      await givePolicy(future.id, "تأمين المستقبل", "2099-01-01", "2100-01-01");
      // Two policies, one dead and one open-ended. The live one must win the badge.
      await givePolicy(twoPolicies.id, "وثيقة قديمة", "2018-01-01", "2019-01-01");
      await givePolicy(twoPolicies.id, "وثيقة سارية", "2021-01-01", null);
    });

    it("badges an in-force policy as ACTIVE, with the insurer", async () => {
      expect(await badgeFor(insured.id)).toEqual({
        insurerName: "المصرية للتأمين",
        standing: "ACTIVE",
      });
    });

    it("badges an ended policy as LAPSED rather than hiding it", async () => {
      // Shown, not hidden: a patient whose cover ended is a conversation reception has to have, and
      // "no active policy" invites the reader to assume there never was one.
      expect(await badgeFor(lapsed.id)).toEqual({ insurerName: "مصر للتأمين", standing: "LAPSED" });
    });

    it("badges a policy that has not started as FUTURE", async () => {
      expect(await badgeFor(future.id)).toEqual({
        insurerName: "تأمين المستقبل",
        standing: "FUTURE",
      });
    });

    it("picks the live policy when a patient holds two", async () => {
      expect(await badgeFor(twoPolicies.id)).toEqual({
        insurerName: "وثيقة سارية",
        standing: "ACTIVE",
      });
    });

    it("is null — not an empty object — when no policy is recorded", async () => {
      // The distinction the screen depends on: no policy and a lapsed policy are different answers.
      expect(await badgeFor(neverSeen.id)).toBeNull();
    });
  });

  describe("whose screen it is", () => {
    it("is open to reception, admin and owner", async () => {
      for (const token of [receptionToken, adminToken, ownerToken]) {
        expect((await get("/patients/recent", token)).status).toBe(200);
      }
    });

    it("is refused to a doctor, at the guard", async () => {
      expect((await get("/patients/recent", doctorToken)).status).toBe(403);
    });

    it("does not shut a doctor out of an individual patient, which was never the rule", async () => {
      // Q23: a patient belongs to the clinic, not to a doctor. `patients.browse` decides whose
      // screen the book is, and nothing more. If this ever returns 403, someone has mistaken the
      // browse ruling for an ownership boundary and narrowed patients.write with it.
      expect((await get(`/patients/${seenRecently.id}`, doctorToken)).status).toBe(200);
    });
  });

  describe("ordering", () => {
    it("puts the most recently seen patient first", async () => {
      const { patients } = await page("?limit=50");
      const seenIds = patients.filter((p) => p.lastSeenAt !== null).map((p) => p.id);

      expect(seenIds.indexOf(seenRecently.id)).toBeLessThan(seenIds.indexOf(seenLongAgo.id));
    });

    it("treats a future booking as not seen, rather than as the most recent visit", async () => {
      const { patients } = await page("?limit=50");
      const booked = patients.find((p) => p.id === bookedButNotSeen.id);

      // The failure this catches: ordering by max(scheduled_start) over all appointments, which
      // would rank a patient booked next June above everyone who was actually here last week.
      expect(booked?.lastSeenAt).toBeNull();
    });

    it("sorts everyone never seen after everyone seen", async () => {
      const { patients } = await page("?limit=50");
      const firstUnseen = patients.findIndex((p) => p.lastSeenAt === null);
      const lastSeen = patients.map((p) => p.lastSeenAt !== null).lastIndexOf(true);

      expect(firstUnseen).toBeGreaterThan(lastSeen);
    });

    it("still lists a patient who has never been seen at all", async () => {
      const { patients } = await page("?limit=50");
      expect(patients.map((p) => p.id)).toContain(neverSeen.id);
    });
  });

  describe("paging", () => {
    it("reports a total that is larger than one page", async () => {
      const first = await page("?limit=2");
      expect(first.patients).toHaveLength(2);
      expect(first.total).toBeGreaterThan(2);
    });

    it("does not repeat or skip a row across two pages", async () => {
      const first = await page("?limit=2&offset=0");
      const second = await page("?limit=2&offset=2");
      const ids = [...first.patients, ...second.patients].map((p) => p.id);

      expect(new Set(ids).size).toBe(ids.length);
    });

    it("refuses a limit beyond the cap rather than serving the whole table", async () => {
      expect((await get("/patients/recent?limit=5000", receptionToken)).status).toBe(400);
    });

    it("needs no query string at all", async () => {
      const { patients } = await page("");
      expect(patients.length).toBeGreaterThan(0);
    });
  });

  describe("tenant isolation", () => {
    it("never returns another clinic's patients", async () => {
      const { patients } = await page("?limit=50");
      const ids = new Set(patients.map((p) => p.id));

      expect(ids.has(clinicB.patientId)).toBe(false);
    });

    it("counts only this clinic in the total", async () => {
      const { total } = await page("?limit=1");
      const actual = await withTenant(clinicA.tenantId, actorFor(clinicA.userId), (tx) =>
        tx.patient.count(),
      );
      expect(total).toBe(actual);
    });
  });

  describe("the route resolves as a route, not as an id", () => {
    it("does not fall through to GET /patients/:id and answer 400", async () => {
      // `recent` is not a UUID, so if it were declared after the parameterised route ParseUUIDPipe
      // would reject it. Declaration order is load-bearing and nothing else would catch a change.
      expect((await get("/patients/recent", receptionToken)).status).toBe(200);
    });
  });
});
