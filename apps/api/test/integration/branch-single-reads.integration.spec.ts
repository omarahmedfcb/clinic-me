// Branches step 5c: a single-row read outside the caller's branches is the handler's 404, and records nothing
// (ruled 2026-10-30). The set is derived from the registry; a suspended branch's past row reads normally.
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { AppModule } from "../../src/app.module.ts";
import { BRANCH_ENFORCEMENT } from "../../src/common/branch-enforcement.ts";
import { refusingValidationPipe } from "../../src/common/validation-pipe.ts";
import { issueAccessToken } from "../../src/modules/auth/jwt.ts";
import { injected } from "../../src/prisma/injected.ts";
import { appointment, as, visitOn, worldFor, type Actor, type World } from "./branch-existing-rows.fixtures.ts";
import { createTestUser, deleteTestUser, seedClinic, teardownClinic, type ClinicFixture } from "./fixtures.ts";

interface Read { actor: Actor; path: (world: World, branchId: string, dayOffset: number) => Promise<string> }

async function chargeIn(w: World, branchId: string, dayOffset: number): Promise<{ charge: string }> {
  const visitId = await visitOn(w, await appointment(w, branchId, "COMPLETED", dayOffset));
  return as(w.clinic, async (tx) => ({ charge: (await tx.visitCharge.create({ data: injected({ id: randomUUID(), visitId, patientId: w.clinic.patientId }) })).id }));
}

const READS: Record<string, Read> = {
  "GET /appointments/:id/detail": { actor: "reception", path: async (w, b, d) => `/appointments/${await appointment(w, b, "BOOKED", d)}/detail` },
  "GET /bot/appointments/:id": { actor: "bot", path: async (w, b, d) => `/bot/appointments/${await appointment(w, b, "BOOKED", d)}` },
  "GET /charges/:chargeId": { actor: "reception", path: async (w, b, d) => `/charges/${(await chargeIn(w, b, d)).charge}` },
  "GET /charges/:chargeId/split": { actor: "reception", path: async (w, b, d) => `/charges/${(await chargeIn(w, b, d)).charge}/split` },
  "GET /appointments/:id/visit/:visitId/pricing": {
    actor: "doctor",
    path: async (w, b) => {
      const id = await appointment(w, b, "IN_CONSULTATION");
      return `/appointments/${id}/visit/${await visitOn(w, id)}/pricing`;
    },
  },
};

// Scoped, but by ruling it shows every branch, labelled and marked editable (BRANCHES-DESIGN §5).
const EVERY_BRANCH_BY_RULING = ["GET /doctors/:doctorId/schedule"];

describe("branch scope on single-row reads (step 5c)", () => {
  let app: NestExpressApplication;
  let baseUrl = "";
  let clinic: ClinicFixture;
  let scoped: World;
  let branchB = "";
  let suspended = "";
  let adminAll = "";
  let adminUser = "";

  const send = async (token: string, path: string): Promise<number> =>
    (await fetch(`${baseUrl}${path}`, { headers: { authorization: `Bearer ${token}` } })).status;
  const refusalsRecorded = (): Promise<number> =>
    as(clinic, (tx) => tx.auditLog.count({ where: { action: "BRANCH_SCOPE_REFUSED" } }));

  beforeAll(async () => {
    process.env["ATTACHMENTS_STORAGE_ROOT"] ??= process.cwd();
    clinic = await seedClinic();
    branchB = randomUUID();
    suspended = randomUUID();
    await as(clinic, async (tx) => {
      for (const [id, p] of [[branchB, "B"], [suspended, "S"]] as const) {
        await tx.branch.create({ data: injected({ id, name: p, address: "Giza", phone: "+201000000001", receiptPrefix: p, invoicePrefix: p }) });
      }
    });
    scoped = await worldFor(clinic, clinic.branchId);
    adminUser = await createTestUser();
    const membershipId = randomUUID();
    await as(clinic, (tx) => tx.membership.create({ data: injected({ id: membershipId, userId: adminUser, role: "ADMIN", status: "ACTIVE" }) }));
    adminAll = await issueAccessToken({ sub: adminUser, membershipId, tenantId: clinic.tenantId, role: "ADMIN" });

    app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: false });
    app.useGlobalPipes(refusingValidationPipe());
    await app.listen(0);
    baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await app?.close();
    await teardownClinic(clinic);
    for (const userId of [...scoped.users, adminUser]) await deleteTestUser(userId);
  });

  test("the set is every scoped single-row read in the registry", () => {
    const derived = Object.entries(BRANCH_ENFORCEMENT)
      .filter(([route, status]) => status === "scoped" && route.startsWith("GET ") && /\/:[A-Za-z]+/.test(route))
      .map(([route]) => route)
      .filter((route) => !EVERY_BRANCH_BY_RULING.includes(route));
    expect(derived.sort()).toEqual(Object.keys(READS).sort());
  });

  describe.each(Object.entries(READS))("%s", (_route, read) => {
    test("in the caller's branch it reads", async () => {
      expect(await send(scoped.tokens[read.actor], await read.path(scoped, clinic.branchId, 2))).toBe(200);
    });

    test("in another branch it is 404, and no refusal is recorded", async () => {
      const before = await refusalsRecorded();
      expect(await send(scoped.tokens[read.actor], await read.path(scoped, branchB, 2))).toBe(404);
      expect(await refusalsRecorded()).toBe(before);
    });
  });

  describe("a suspended branch", () => {
    let pastDetail = "";
    let laterDetail = "";
    let pastCharge = "";

    beforeAll(async () => {
      pastDetail = await READS["GET /appointments/:id/detail"]!.path(scoped, suspended, -2);
      laterDetail = await READS["GET /appointments/:id/detail"]!.path(scoped, suspended, 2);
      pastCharge = await READS["GET /charges/:chargeId"]!.path(scoped, suspended, -2);
      await as(clinic, (tx) => tx.branch.update({ where: { id: suspended }, data: { status: "SUSPENDED", suspendedAt: new Date(), suspensionReason: "limit lowered" } }));
    });

    test("its past rows read normally for a caller over every branch", async () => {
      expect(await send(adminAll, pastDetail)).toBe(200);
      expect(await send(adminAll, pastCharge)).toBe(200);
    });

    test("a row dated after its suspension does not", async () => {
      expect(await send(adminAll, laterDetail)).toBe(404);
    });
  });
});
