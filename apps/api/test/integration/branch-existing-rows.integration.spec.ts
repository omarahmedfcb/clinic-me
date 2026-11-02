import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { AppModule } from "../../src/app.module.ts";
import { BRANCH_ENFORCEMENT } from "../../src/common/branch-enforcement.ts";
import { refusingValidationPipe } from "../../src/common/validation-pipe.ts";
import { injected } from "../../src/prisma/injected.ts";
import { appointment, as, CASES, visitOn, worldFor, type Actor, type World } from "./branch-existing-rows.fixtures.ts";
import { createTestUser, deleteTestUser, seedClinic, teardownClinic, type ClinicFixture } from "./fixtures.ts";

// Scoped writes whose branch the caller names (a slot token, a query or body branch), checked by 4a and
// stage 2: they create rather than act on a stored row, so they are not this set.
const NAMES_ITS_BRANCH = [
  "POST /appointments",
  "POST /bot/appointments",
  "POST /doctors/:doctorId/schedule/exceptions",
  "PUT /doctors/:doctorId/schedule/templates",
];

describe("branch scope on writes to existing rows (step 4b stage 3)", () => {
  let app: NestExpressApplication;
  let baseUrl = "";
  const clinics: ClinicFixture[] = [];
  let scoped: World;
  let single: World;
  let foreign: World;
  let branchA = "";
  let branchB = "";

  const send = (world: World, actor: Actor, route: string, path: string, body?: unknown): Promise<Response> =>
    fetch(`${baseUrl}${path}`, {
      method: route.split(" ")[0],
      headers: { authorization: `Bearer ${world.tokens[actor]}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  const refusalsRecorded = async (clinic: ClinicFixture, entityId: string): Promise<{ branch: string | null }[]> =>
    as(clinic, (tx) =>
      tx.$queryRaw<{ branch: string | null }[]>`
        SELECT branch_id::text AS branch FROM audit_logs
         WHERE entity_id = ${entityId}::uuid AND action::text = 'BRANCH_SCOPE_REFUSED'`,
    );

  beforeAll(async () => {
    process.env["ATTACHMENTS_STORAGE_ROOT"] ??= process.cwd();
    const [two, one, other] = [await seedClinic(), await seedClinic(), await seedClinic()];
    clinics.push(two, one, other);
    branchA = two.branchId;
    branchB = randomUUID();
    await as(two, (tx) =>
      tx.branch.create({ data: injected({ id: branchB, name: "Second", address: "Giza", phone: "+201000000001", receiptPrefix: "B", invoicePrefix: "B" }) }),
    );
    scoped = await worldFor(two, branchA);
    single = await worldFor(one);
    foreign = await worldFor(other);

    app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: false });
    app.useGlobalPipes(refusingValidationPipe());
    await app.listen(0);
    baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await app?.close();
    for (const clinic of clinics) await teardownClinic(clinic);
    for (const userId of [scoped, single, foreign].flatMap((w) => w?.users ?? [])) await deleteTestUser(userId);
  });

  test("the set is every scoped write that acts on a row it did not create", () => {
    const writes = Object.entries(BRANCH_ENFORCEMENT)
      .filter(([route, status]) => status === "scoped" && !route.startsWith("GET ") && !NAMES_ITS_BRANCH.includes(route))
      .map(([route]) => route)
      .sort();
    expect(writes).toEqual(Object.keys(CASES).sort());
  });

  describe.each(Object.entries(CASES))("%s", (route, c) => {
    test("in the caller's branch it is not refused as not found", async () => {
      const built = await c.build(scoped, branchA);
      const response = await send(scoped, c.actor, route, built.path, built.body);
      expect({ status: response.status, body: await response.text() }).not.toMatchObject({ status: 404 });
    });

    test("in another branch it is the handler's own 404, and the refusal is audited in that branch", async () => {
      const built = await c.build(scoped, branchB);
      const response = await send(scoped, c.actor, route, built.path, built.body);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ code: "NOT_FOUND", params: { resource: c.resource } });
      expect(await refusalsRecorded(scoped.clinic, built.entityId)).toEqual([{ branch: branchB }]);
    });

    test("a single-branch clinic, narrowest scopes, rows naming its one branch: never refused", async () => {
      const built = await c.build(single, single.inBranch);
      const response = await send(single, c.actor, route, built.path, built.body);
      expect(response.status).not.toBe(404);
      expect(await refusalsRecorded(single.clinic, built.entityId)).toEqual([]);
    });

    test("another clinic's row is 404 before any branch check, so no branch refusal is recorded", async () => {
      const built = await c.build(foreign, foreign.inBranch, scoped);
      const response = await send(scoped, c.actor, route, built.path, built.body);
      expect(response.status).toBe(404);
      expect(await refusalsRecorded(scoped.clinic, built.entityId)).toEqual([]);
    });
  });

  describe("clinic-level routes get no branch check", () => {
    test("notifications, /visits/open and transfers are classified clinic-level", () => {
      const routes = Object.keys(BRANCH_ENFORCEMENT).filter((r) => /\/(notifications|transfers)\b|\/visits\/open$/.test(r));
      expect(routes.length).toBe(8);
      expect(routes.filter((r) => BRANCH_ENFORCEMENT[r] !== "clinic-level")).toEqual([]);
    });

    test("a doctor scoped to branch A sees an open visit in branch B", async () => {
      const inB = await appointment(scoped, branchB, "IN_CONSULTATION");
      await visitOn(scoped, inB);
      const response = await send(scoped, "doctor", "GET", "/visits/open");
      expect(response.status).toBe(200);
      expect(await response.text()).toContain(inB);
    });

    test("a receptionist scoped to branch A reads and marks a notification about branch B", async () => {
      const inB = await appointment(scoped, branchB, "BOOKED", 4);
      const id = randomUUID();
      await as(scoped.clinic, (tx) =>
        tx.notification.create({
          data: injected({ id, kind: "APPOINTMENT_BOOKED", appointmentId: inB, actorUserId: scoped.clinic.userId, source: "RECEPTION", occurredAt: new Date(), payload: {} }),
        }),
      );
      const list = await send(scoped, "reception", "GET", "/notifications");
      expect(await list.text()).toContain(id);
      expect((await send(scoped, "reception", "POST", "/notifications/read", { ids: [id] })).status).toBeLessThan(300);
    });

    test("a receptionist scoped to branch A requests a transfer for an appointment in branch B", async () => {
      const toDoctorId = await secondDoctor(scoped.clinic, scoped.users);
      const inB = await appointment(scoped, branchB, "WAITING");
      const response = await send(scoped, "reception", "POST", "/transfers", { appointmentId: inB, toDoctorId });
      expect(response.status).toBeLessThan(300);
    });
  });
});

async function secondDoctor(clinic: ClinicFixture, users: string[]): Promise<string> {
  const userId = await createTestUser();
  users.push(userId);
  const doctorId = randomUUID();
  await as(clinic, async (tx) => {
    const membershipId = randomUUID();
    await tx.membership.create({ data: injected({ id: membershipId, userId, role: "DOCTOR", status: "ACTIVE" }) });
    await tx.doctor.create({ data: injected({ id: doctorId, membershipId, specialty: "General", licenseNumber: `LIC-${doctorId.slice(0, 8)}`, title: "Dr." }) });
  });
  return doctorId;
}
