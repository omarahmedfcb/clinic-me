// Branches step 5b: every scoped list read covers the selected branch, else every branch the caller holds;
// every slot offered under a context can be booked under it; a one-branch clinic reads identically.
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { AppModule } from "../../src/app.module.ts";
import { refusingValidationPipe } from "../../src/common/validation-pipe.ts";
import type { MembershipRole } from "../../src/generated/prisma/enums.ts";
import { issueAccessToken } from "../../src/modules/auth/jwt.ts";
import { injected } from "../../src/prisma/injected.ts";
import { type TransactionClient, withTenant } from "../../src/prisma/with-tenant.ts";
import { actorFor, createTestUser, deleteTestUser, seedClinic, teardownClinic, type ClinicFixture } from "./fixtures.ts";

const isoDay = (offset: number): string => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const WEDNESDAY = ((): string => {
  const day = new Date(Date.now() + 3 * 86_400_000);
  while (day.getUTCDay() !== 3) day.setUTCDate(day.getUTCDate() + 1);
  return day.toISOString().slice(0, 10);
})();
const PAST = isoDay(-2);

type Caller = "admin" | "scopedAdmin" | "reception" | "bot";

describe("branch scope on the list reads (step 5b)", () => {
  let app: NestExpressApplication;
  let baseUrl = "";
  let clinic: ClinicFixture;
  let single: ClinicFixture;
  let branchA = "";
  let branchB = "";
  const past = { a: "", b: "" };
  const users: string[] = [];
  const tokens: Record<Caller, string> = { admin: "", scopedAdmin: "", reception: "", bot: "" };
  const singleTokens: Record<"admin" | "reception", string> = { admin: "", reception: "" };

  const as = <T>(fixture: ClinicFixture, work: (tx: TransactionClient) => Promise<T>): Promise<T> =>
    withTenant(fixture.tenantId, actorFor(fixture.userId), work);

  const request = (token: string, method: string, path: string, branch?: string, body?: unknown): Promise<Response> =>
    fetch(`${baseUrl}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(branch === undefined ? {} : { "x-branch-id": branch }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const get = async (who: Caller, path: string, branch?: string): Promise<unknown> => {
    const response = await request(tokens[who], "GET", path, branch);
    expect(response.status).toBe(200);
    return response.json();
  };

  async function member(fixture: ClinicFixture, role: MembershipRole, onlyBranch?: string): Promise<string> {
    const userId = await createTestUser();
    users.push(userId);
    const membershipId = randomUUID();
    await as(fixture, async (tx) => {
      await tx.membership.create({ data: injected({ id: membershipId, userId, role, status: "ACTIVE" }) });
      if (onlyBranch === undefined) return;
      await tx.membership.update({ where: { id: membershipId }, data: { branchScope: "SELECTED" } });
      await tx.membershipBranch.deleteMany({ where: { membershipId } });
      await tx.membershipBranch.create({ data: injected({ id: randomUUID(), membershipId, branchId: onlyBranch }) });
    });
    return issueAccessToken({ sub: userId, membershipId, tenantId: fixture.tenantId, role });
  }

  async function workday(fixture: ClinicFixture, branchId: string, from: string, to: string): Promise<void> {
    await as(fixture, (tx) =>
      tx.scheduleTemplate.create({
        data: injected({ id: randomUUID(), branchId, doctorId: fixture.doctorId, weekday: 3, startTime: new Date(`1970-01-01T${from}:00Z`), endTime: new Date(`1970-01-01T${to}:00Z`), validFrom: new Date("2020-01-01") }),
      }),
    );
  }

  async function booked(fixture: ClinicFixture, branchId: string, at: string): Promise<string> {
    const id = randomUUID();
    const start = new Date(at);
    await as(fixture, (tx) =>
      tx.appointment.create({
        data: injected({ id, branchId, patientId: fixture.patientId, doctorId: fixture.doctorId, serviceId: fixture.serviceId, scheduledStart: start, scheduledEnd: new Date(start.getTime() + 30 * 60_000), status: "BOOKED", source: "RECEPTION", createdBy: fixture.userId, updatedBy: fixture.userId }),
      }),
    );
    return id;
  }

  beforeAll(async () => {
    process.env["ATTACHMENTS_STORAGE_ROOT"] ??= process.cwd();
    clinic = await seedClinic();
    branchA = clinic.branchId;
    branchB = randomUUID();
    await as(clinic, (tx) => tx.branch.create({ data: injected({ id: branchB, name: "Second", address: "Giza", phone: "+201000000001", receiptPrefix: "B", invoicePrefix: "B" }) }));
    await workday(clinic, branchA, "09:00", "10:00");
    await workday(clinic, branchB, "12:00", "13:00");
    past.a = await booked(clinic, branchA, `${PAST}T08:00:00Z`);
    past.b = await booked(clinic, branchB, `${PAST}T10:00:00Z`);

    tokens.admin = await member(clinic, "ADMIN");
    tokens.scopedAdmin = await member(clinic, "ADMIN", branchA);
    tokens.reception = await member(clinic, "RECEPTIONIST", branchA);
    tokens.bot = await member(clinic, "AI_AGENT");

    single = await seedClinic();
    await workday(single, single.branchId, "09:00", "10:00");
    await booked(single, single.branchId, `${PAST}T08:00:00Z`);
    singleTokens.admin = await member(single, "ADMIN");
    singleTokens.reception = await member(single, "RECEPTIONIST");

    app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: false });
    app.useGlobalPipes(refusingValidationPipe());
    await app.listen(0);
    baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await app?.close();
    await teardownClinic(clinic);
    await teardownClinic(single);
    for (const userId of users) await deleteTestUser(userId);
  });

  // What each list read shows of the two branches, as a set of branch markers comparable across callers.
  const reads = (f: () => ClinicFixture) => ({
    availability: async (who: Caller, branch?: string) =>
      new Set(((await get(who, `/availability?doctorId=${f().doctorId}&serviceId=${f().serviceId}&date=${WEDNESDAY}`, branch)) as { slots: { branchId: string }[] }).slots.map((s) => s.branchId)),
    "schedule/day": async (who: Caller, branch?: string) =>
      ((await get(who, `/schedule/day?doctorId=${f().doctorId}&date=${WEDNESDAY}`, branch)) as { working: unknown[] }).working.length,
    "schedule/range": async (who: Caller, branch?: string) =>
      ((await get(who, `/schedule/range?doctorId=${f().doctorId}&from=${WEDNESDAY}&to=${WEDNESDAY}`, branch)) as { days: { working: unknown[] }[] }).days[0]!.working.length,
    "schedule/month": async (who: Caller, branch?: string) =>
      ((await get(who, `/schedule/month?month=${PAST.slice(0, 7)}`, branch)) as { days: { date: string; total: number; finished: number }[] }).days
        .filter((d) => d.date === PAST).reduce((n, d) => n + d.total + d.finished, 0),
    "schedule/day/bookings": async (who: Caller, branch?: string) =>
      new Set(((await get(who, `/schedule/day/bookings?date=${PAST}`, branch)) as { bookings: { appointmentId: string }[] }).bookings.map((b) => b.appointmentId)),
    "queue/today": async (who: Caller, branch?: string) =>
      new Set(((await get(who, `/queue/today?date=${PAST}`, branch)) as { entries: { appointmentId: string }[] }).entries.map((e) => e.appointmentId)),
    "no-shows/pending": async (who: Caller, branch?: string) =>
      new Set(((await get(who, `/no-shows/pending?date=${PAST}`, branch)) as { candidates: { appointmentId: string }[] }).candidates.map((c) => c.appointmentId)),
  });
  const two = reads(() => clinic);

  describe("a list read covers the selected branch, else every branch the caller holds", () => {
    test("availability", async () => {
      expect(await two.availability("admin")).toEqual(new Set([branchA, branchB]));
      expect(await two.availability("admin", branchB)).toEqual(new Set([branchB]));
      expect(await two.availability("reception")).toEqual(new Set([branchA]));
    });

    test("the bot's slots", async () => {
      const slots = async (branch?: string) =>
        new Set(((await get("bot", `/bot/slots?doctorId=${clinic.doctorId}&serviceId=${clinic.serviceId}&date=${WEDNESDAY}`, branch)) as { slots: { branchId: string }[] }).slots.map((s) => s.branchId));
      expect(await slots()).toEqual(new Set([branchA, branchB]));
      expect(await slots(branchA)).toEqual(new Set([branchA]));
    });

    test.each([["schedule/day"], ["schedule/range"]] as const)("%s: the doctor's working sessions", async (route) => {
      expect(await two[route]("admin")).toBe(2);
      expect(await two[route]("admin", branchA)).toBe(1);
      expect(await two[route]("scopedAdmin")).toBe(1);
    });

    test("schedule/month counts", async () => {
      expect(await two["schedule/month"]("admin")).toBe(2);
      expect(await two["schedule/month"]("admin", branchB)).toBe(1);
      expect(await two["schedule/month"]("reception")).toBe(1);
    });

    test.each([["schedule/day/bookings"], ["queue/today"], ["no-shows/pending"]] as const)("%s", async (route) => {
      expect(await two[route]("admin")).toEqual(new Set([past.a, past.b]));
      expect(await two[route]("admin", branchB)).toEqual(new Set([past.b]));
      expect(await two[route]("reception")).toEqual(new Set([past.a]));
    });

    test("an unknown X-Branch-Id is 404 on a read", async () => {
      const response = await request(tokens.admin, "GET", `/queue/today?date=${PAST}`, randomUUID());
      expect(response.status).toBe(404);
    });

    test("the schedule editor shows every branch's hours, each labelled, editable only in scope", async () => {
      const schedule = (await get("scopedAdmin", `/doctors/${clinic.doctorId}/schedule`)) as { templates: { branchId: string; editable: boolean }[] };
      expect(schedule.templates.map((t) => [t.branchId, t.editable]).sort()).toEqual([[branchA, true], [branchB, false]].sort());
    });
  });

  describe("every slot offered under a branch context can be booked under that same context", () => {
    const bookEach = async (who: "reception" | "admin" | "bot", branch: string | undefined): Promise<{ offered: number; refused: string[] }> => {
      const path = who === "bot" ? "/bot/slots" : "/availability";
      const { slots } = (await get(who, `${path}?doctorId=${clinic.doctorId}&serviceId=${clinic.serviceId}&date=${WEDNESDAY}`, branch)) as { slots: { token: string; start: string; branchId: string }[] };
      const refused: string[] = [];
      for (const slot of slots) {
        const response = who === "bot"
          ? await request(tokens.bot, "POST", "/bot/appointments", branch, { slotToken: slot.token, patientId: clinic.patientId, consentMessageId: `wamid.reads-${randomUUID()}` })
          : await request(tokens[who], "POST", "/appointments", branch, { slotToken: slot.token, patientId: clinic.patientId, source: "RECEPTION" });
        if (response.status >= 300) {
          refused.push(`${slot.branchId} ${slot.start} → ${response.status}`);
          continue;
        }
        const { appointmentId } = (await response.json()) as { appointmentId: string };
        const cancel = who === "bot"
          ? await request(tokens.bot, "POST", `/bot/appointments/${appointmentId}/cancel`, branch, { reason: "test" })
          : await request(tokens[who], "PATCH", `/appointments/${appointmentId}/cancel`, branch, { reason: "test" });
        expect(cancel.status).toBeLessThan(300);
      }
      return { offered: slots.length, refused };
    };

    test.each([
      ["a receptionist scoped to branch A, no header", "reception", undefined],
      ["an admin, branch B selected", "admin", "B"],
      ["an admin over every branch, no header", "admin", undefined],
      ["the bot, branch B selected", "bot", "B"],
    ] as const)("%s", async (_name, who, selected) => {
      const result = await bookEach(who, selected === "B" ? branchB : undefined);
      expect(result.offered).toBeGreaterThan(0);
      expect(result.refused).toEqual([]);
    }, 120_000);
  });

  describe("a single-branch clinic reads byte-identically with no header, its branch, or all", () => {
    const strip = (body: string): string => body.replace(/"token":"[^"]*"/g, '"token":"…"');
    const paths = () => [
      `/availability?doctorId=${single.doctorId}&serviceId=${single.serviceId}&date=${WEDNESDAY}`,
      `/schedule/day?doctorId=${single.doctorId}&date=${WEDNESDAY}`,
      `/schedule/range?doctorId=${single.doctorId}&from=${WEDNESDAY}&to=${WEDNESDAY}`,
      `/schedule/month?month=${PAST.slice(0, 7)}`,
      `/schedule/day/bookings?date=${PAST}`,
      `/queue/today?date=${PAST}`,
      `/no-shows/pending?date=${PAST}`,
      `/doctors/${single.doctorId}/schedule`,
    ];

    test("every scoped list read", async () => {
      for (const path of paths()) {
        const bodies: string[] = [];
        for (const branch of [undefined, single.branchId, "all"]) {
          const response = await request(singleTokens.admin, "GET", path, branch);
          expect({ path, status: response.status }).toEqual({ path, status: 200 });
          bodies.push(strip(await response.text()));
        }
        expect({ path, same: new Set(bodies).size }).toEqual({ path, same: 1 });
      }
    });

    // Identity across headers holds by construction (step 3 resolves any header to the one branch), so it
    // cannot catch a filter that is wrong for all three alike. This does: the clinic sees its own rows.
    test("and what it reads is all of its own rows", async () => {
      const read = async (path: string) => (await (await request(singleTokens.admin, "GET", path)).json()) as Record<string, unknown[]>;
      expect((await read(`/availability?doctorId=${single.doctorId}&serviceId=${single.serviceId}&date=${WEDNESDAY}`))["slots"]!.length).toBeGreaterThan(0);
      expect((await read(`/schedule/day/bookings?date=${PAST}`))["bookings"]).toHaveLength(1);
      expect((await read(`/queue/today?date=${PAST}`))["entries"]).toHaveLength(1);
      expect((await read(`/no-shows/pending?date=${PAST}`))["candidates"]).toHaveLength(1);
      expect((await read(`/doctors/${single.doctorId}/schedule`))["templates"]).toHaveLength(1);
    });
  });
});
