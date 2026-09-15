import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Module, ValidationPipe } from "@nestjs/common";
import { APP_INTERCEPTOR, NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import type { AddressInfo } from "node:net";
import { ActorContextInterceptor } from "../../src/common/actor-context.interceptor.ts";
import { issueAccessToken } from "../../src/modules/auth/jwt.ts";
import { ClinicalController } from "../../src/modules/clinical/clinical.controller.ts";
import { prisma } from "../../src/prisma/client.ts";
import { injected } from "../../src/prisma/injected.ts";
import { withTenant } from "../../src/prisma/with-tenant.ts";
import { actorFor, seedClinic, teardownClinic, type ClinicFixture } from "./fixtures.ts";

/**
 * The append-only clinical profile (Q22) and what a visit orders (Q24, Q8). `PHASE-4-PLAN.md` 7e.
 *
 * Two assertions carry this file. **The profile's append-only trigger is proven by attempting an
 * UPDATE and a DELETE** — Q22's whole claim is that a clinical record cannot be silently rewritten,
 * and a service-layer promise of that passes on a database that never got the trigger. And **the
 * migration's own copy statements are run against a source row**, because 7e's migration rule says
 * every existing row survives with its own author, and a migration nobody exercised is a guess.
 */

@Module({
  controllers: [ClinicalController],
  providers: [{ provide: APP_INTERCEPTOR, useClass: ActorContextInterceptor }],
})
class VisitOrdersTestModule {}

let fixtureSlot = 0;
/** A distinct past half-hour per fixture appointment: `no_double_booking` is a live constraint. */
function nextFixtureSlot(): Date {
  fixtureSlot += 1;
  return new Date(Date.now() - fixtureSlot * 24 * 60 * 60_000);
}

describe("the visit's orders and its patient profile", () => {
  let app: NestExpressApplication;
  let baseUrl: string;
  let clinic: ClinicFixture;
  let doctorToken = "";
  let appointmentId = "";
  let visitId = "";

  const call = async (method: string, url: string, body?: unknown): Promise<Response> =>
    fetch(`${baseUrl}${url}`, {
      method,
      headers: {
        authorization: `Bearer ${doctorToken}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  const liveAppointment = async (): Promise<string> => {
    const id = randomUUID();
    await withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) => {
      const start = nextFixtureSlot();
      await tx.appointment.create({
        data: injected({
          id,
          patientId: clinic.patientId,
          doctorId: clinic.doctorId,
          serviceId: clinic.serviceId,
          quotedPriceMinor: 10000,
          scheduledStart: start,
          scheduledEnd: new Date(start.getTime() + 30 * 60_000),
          status: "IN_CONSULTATION",
          source: "RECEPTION",
          arrivedAt: start,
          waitingStartedAt: start,
          consultationStartedAt: start,
          createdBy: clinic.userId,
          updatedBy: clinic.userId,
        }),
      });
    });
    return id;
  };

  beforeAll(async () => {
    clinic = await seedClinic();
    doctorToken = await issueAccessToken({
      sub: clinic.userId,
      membershipId: clinic.membershipId,
      tenantId: clinic.tenantId,
      role: "DOCTOR",
    });

    app = await NestFactory.create<NestExpressApplication>(VisitOrdersTestModule, { logger: false });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.listen(0);
    baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;

    appointmentId = await liveAppointment();
    const opened = await call("POST", `/appointments/${appointmentId}/visit/draft`);
    visitId = ((await opened.json()) as { id: string }).id;
  });

  afterAll(async () => {
    await app?.close();
    await teardownClinic(clinic);
    await prisma.$disconnect();
  });

  test("a profile entry is appended with its author and timestamp, and never replaces the last one", async () => {
    const first = await call("POST", `/appointments/${appointmentId}/clinical-profile`, {
      field: "PAST_MEDICAL",
      content: "سكري من النوع الثاني منذ 2019",
    });
    expect(first.status).toBe(201);

    const second = await call("POST", `/appointments/${appointmentId}/clinical-profile`, {
      field: "PAST_MEDICAL",
      content: "سكري من النوع الثاني منذ 2019، وضغط منذ 2023",
    });
    expect(second.status).toBe(201);

    const profile = (await second.json()) as {
      entries: { field: string; content: string; authorName: string }[];
      lastUpdatedBy: string | null;
    };
    // Two entries, not one corrected one. The earlier statement is still readable, which is what
    // "append-only" means to whoever reads the record later.
    expect(profile.entries.filter((entry) => entry.field === "PAST_MEDICAL")).toHaveLength(2);
    expect(profile.entries[0]?.content).toContain("وضغط منذ 2023");
    expect(profile.lastUpdatedBy).not.toBeNull();
  });

  test("the append-only trigger refuses an update and a delete on a profile entry (Q22, D5)", async () => {
    await call("POST", `/appointments/${appointmentId}/clinical-profile`, {
      field: "RISK_FACTORS",
      content: "تدخين",
    });

    const entryId = await withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) => {
      const row = await tx.patientClinicalProfileEntry.findFirstOrThrow({
        where: { patientId: clinic.patientId, field: "RISK_FACTORS" },
      });
      return row.id;
    });

    await expect(
      withTenant(clinic.tenantId, actorFor(clinic.userId), (tx) =>
        tx.patientClinicalProfileEntry.update({ where: { id: entryId }, data: { content: "rewritten" } }),
      ),
    ).rejects.toThrow();

    await expect(
      withTenant(clinic.tenantId, actorFor(clinic.userId), (tx) =>
        tx.patientClinicalProfileEntry.delete({ where: { id: entryId } }),
      ),
    ).rejects.toThrow();

    await withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) => {
      const row = await tx.patientClinicalProfileEntry.findFirstOrThrow({ where: { id: entryId } });
      expect(row.content).toBe("تدخين");
    });
  });

  test("the migration's own copy keeps every row, with its author and its timestamp", async () => {
    // The statements that shipped, read out of the migration file rather than paraphrased here: a
    // test that retypes the SQL proves the retyping, not the migration.
    const migration = readFileSync(
      path.resolve(
        __dirname,
        "..",
        "..",
        "prisma",
        "migrations",
        "20260908140000_clinical_profile_entries_and_orders",
        "migration.sql",
      ),
      "utf8",
    );
    const copies = migration
      .split(";")
      // Comment lines are dropped first: the statements sit under their own explanation, so a chunk
      // that begins with `--` is still the INSERT this is looking for.
      .map((statement) =>
        statement
          .split(/\r?\n/)
          .filter((line) => !line.trimStart().startsWith("--"))
          .join("\n")
          .trim(),
      )
      .filter((statement) => statement.startsWith('INSERT INTO "patient_clinical_profile_entries"'));
    expect(copies).toHaveLength(2);

    const authored = new Date("2026-09-08T06:30:00.000Z");
    await withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) => {
      // The table the migration read from, recreated for the length of this transaction only.
      await tx.$executeRawUnsafe(`
        CREATE TEMP TABLE patient_clinical_profiles (
          id uuid, tenant_id uuid, patient_id uuid,
          family_history text, risk_factors text,
          updated_by_user_id uuid, updated_at timestamptz
        ) ON COMMIT DROP
      `);
      await tx.$executeRawUnsafe(
        `INSERT INTO patient_clinical_profiles VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6::uuid, $7::timestamptz)`,
        randomUUID(),
        clinic.tenantId,
        clinic.patientId,
        "PRE-MIGRATION FAMILY HISTORY",
        "PRE-MIGRATION RISK FACTORS",
        clinic.userId,
        authored.toISOString(),
      );

      for (const statement of copies) await tx.$executeRawUnsafe(statement);

      const carried = await tx.patientClinicalProfileEntry.findMany({
        where: { patientId: clinic.patientId, content: { startsWith: "PRE-MIGRATION" } },
      });
      expect(carried).toHaveLength(2);
      for (const entry of carried) {
        // The original author and the original instant, not the migration's own.
        expect(entry.authorUserId).toBe(clinic.userId);
        expect(entry.createdAt.toISOString()).toBe(authored.toISOString());
      }
      expect(carried.map((entry) => entry.field).sort()).toEqual(["FAMILY_HISTORY", "RISK_FACTORS"]);

      // Nothing is asserted about the live table, so this fixture leaves no trace.
      throw new RollbackAfterAssertions();
    }).catch((error: unknown) => {
      if (!(error instanceof RollbackAfterAssertions)) throw error;
    });
  });

  test("the prescription is replaced whole, keeps its order, and freezes when the visit completes", async () => {
    const saved = await call("PUT", `/appointments/${appointmentId}/visit/${visitId}/prescription`, {
      notes: "بعد الأكل",
      items: [
        { medicationName: "أموكسيسيلين", dose: "500mg", frequency: "3x", duration: "7 days" },
        { medicationName: "باراسيتامول", dose: "1g", frequency: "prn", duration: "3 days" },
      ],
    });
    expect(saved.status).toBe(200);
    const first = (await saved.json()) as { items: { medicationName: string }[]; notes: string };
    expect(first.items.map((item) => item.medicationName)).toEqual(["أموكسيسيلين", "باراسيتامول"]);

    const reordered = await call("PUT", `/appointments/${appointmentId}/visit/${visitId}/prescription`, {
      notes: "بعد الأكل",
      items: [
        { medicationName: "باراسيتامول", dose: "1g", frequency: "prn", duration: "3 days" },
        { medicationName: "أموكسيسيلين", dose: "500mg", frequency: "3x", duration: "7 days" },
      ],
    });
    const second = (await reordered.json()) as { items: { medicationName: string }[] };
    // `sort_order` is a requirement hiding in a column (Q8): the list has a deliberate order.
    expect(second.items.map((item) => item.medicationName)).toEqual(["باراسيتامول", "أموكسيسيلين"]);
  });

  test("investigations carry free text beside the structured lines, byte for byte", async () => {
    const saved = await call("PUT", `/appointments/${appointmentId}/visit/${visitId}/investigations`, {
      freeText: "صائم من 12 ساعة",
      items: [
        { name: "صورة دم كاملة" },
        { name: "وظائف كبد", notes: "عاجل" },
      ],
    });
    expect(saved.status).toBe(200);
    const value = (await saved.json()) as { freeText: string; items: { name: string; notes: string | null }[] };
    // Clinical free text is stored and returned unchanged — never normalised, never trimmed.
    expect(value.freeText).toBe("صائم من 12 ساعة");
    expect(value.items.map((item) => item.name)).toEqual(["صورة دم كاملة", "وظائف كبد"]);
    expect(value.items[1]?.notes).toBe("عاجل");
  });

  test("the autocomplete offers this clinic's own history, matched on the stored text", async () => {
    const response = await call("GET", `/appointments/${appointmentId}/medications?q=%D8%A3%D9%85%D9%88`);
    expect(response.status).toBe(200);
    expect((await response.json()) as string[]).toContain("أموكسيسيلين");

    // Case is folded because a Latin drug name is typed either way; nothing else is. The Arabic
    // normalisation written for patient-name search is deliberately not reused here.
    const latin = await call("PUT", `/appointments/${appointmentId}/visit/${visitId}/prescription`, {
      items: [{ medicationName: "Augmentin", dose: "1g", frequency: "2x", duration: "5 days" }],
    });
    expect(latin.status).toBe(200);
    const folded = await call("GET", `/appointments/${appointmentId}/medications?q=augmen`);
    expect((await folded.json()) as string[]).toContain("Augmentin");
  });

  test("printing counts, and a finished visit is exactly what gets printed (Q9)", async () => {
    const printed = await call("POST", `/appointments/${appointmentId}/visit/${visitId}/prescription/printed`);
    expect(printed.status).toBe(201);
    expect(((await printed.json()) as { printedCount: number }).printedCount).toBe(1);

    const again = await call("POST", `/appointments/${appointmentId}/visit/${visitId}/prescription/printed`);
    expect(((await again.json()) as { printedCount: number }).printedCount).toBe(2);

    // The write paths refuse a completed visit; this one must not, or the sheet a patient is handed
    // is the one document the system cannot record having produced.
    const ownAppointment = await liveAppointment();
    const opened = await call("POST", `/appointments/${ownAppointment}/visit/draft`);
    const own = (await opened.json()) as { id: string; revision: number };
    await call("PUT", `/appointments/${ownAppointment}/visit/${own.id}/prescription`, {
      items: [{ medicationName: "أموكسيسيلين", dose: "500mg", frequency: "3x", duration: "7 days" }],
    });
    await call("POST", `/appointments/${ownAppointment}/visit/${own.id}/complete`, {
      expectedRevision: own.revision,
    });
    await liveAppointment();

    const afterCompletion = await call(
      "POST",
      `/appointments/${ownAppointment}/visit/${own.id}/prescription/printed`,
    );
    expect(afterCompletion.status).toBe(201);
    expect(((await afterCompletion.json()) as { printedCount: number }).printedCount).toBe(1);
  });

  test("a visit with no prescription reports that there is nothing to print", async () => {
    const ownAppointment = await liveAppointment();
    const opened = await call("POST", `/appointments/${ownAppointment}/visit/draft`);
    const own = (await opened.json()) as { id: string };

    const printed = await call(
      "POST",
      `/appointments/${ownAppointment}/visit/${own.id}/prescription/printed`,
    );
    // Better than reporting a successful print of a sheet with no lines on it.
    expect(printed.status).toBe(404);
  });

  test("a finished visit refuses a new prescription, and points at the amendment path", async () => {
    const ownAppointment = await liveAppointment();
    const opened = await call("POST", `/appointments/${ownAppointment}/visit/draft`);
    const own = (await opened.json()) as { id: string; revision: number };

    await call("POST", `/appointments/${ownAppointment}/visit/${own.id}/complete`, {
      expectedRevision: own.revision,
    });
    // The patient is back with this doctor, so access is not what is being tested.
    await liveAppointment();

    const refused = await call("PUT", `/appointments/${ownAppointment}/visit/${own.id}/prescription`, {
      items: [{ medicationName: "x", dose: "1", frequency: "1", duration: "1" }],
    });
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { code: string }).code).toBe("ALREADY_COMPLETED");
  });
});

/** Thrown to roll back a transaction whose assertions have already run. Never escapes the test. */
class RollbackAfterAssertions extends Error {}
