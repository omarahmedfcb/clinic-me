// A suspended branch (ruled 2026-10-30): its history stays in the reads of those who held it, for dates before
// its suspension; availability never offers it, and no booking lands in it.
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
const PAST = isoDay(-2);
const WEDNESDAY = ((): string => {
  const day = new Date(Date.now() + 3 * 86_400_000);
  while (day.getUTCDay() !== 3) day.setUTCDate(day.getUTCDate() + 1);
  return day.toISOString().slice(0, 10);
})();

describe("a suspended branch's history stays readable; it offers no time", () => {
  let app: NestExpressApplication;
  let baseUrl = "";
  let clinic: ClinicFixture;
  let branchB = "";
  let suspended = "";
  const rows = { a: "", suspendedPast: "", suspendedLater: "" };
  const users: string[] = [];
  const tokens = { admin: "", scopedToB: "" };

  const as = <T>(work: (tx: TransactionClient) => Promise<T>): Promise<T> => withTenant(clinic.tenantId, actorFor(clinic.userId), work);
  const get = async (who: keyof typeof tokens, path: string, branch?: string): Promise<Record<string, unknown>> => {
    const response = await fetch(`${baseUrl}${path}`, { headers: { authorization: `Bearer ${tokens[who]}`, ...(branch === undefined ? {} : { "x-branch-id": branch }) } });
    expect({ path, status: response.status }).toEqual({ path, status: 200 });
    return (await response.json()) as Record<string, unknown>;
  };
  const booked = async (branchId: string, at: string): Promise<string> => {
    const id = randomUUID();
    const start = new Date(at);
    await as((tx) => tx.appointment.create({ data: injected({ id, branchId, patientId: clinic.patientId, doctorId: clinic.doctorId, serviceId: clinic.serviceId, scheduledStart: start, scheduledEnd: new Date(start.getTime() + 30 * 60_000), status: "BOOKED", source: "RECEPTION", createdBy: clinic.userId, updatedBy: clinic.userId }) }));
    return id;
  };
  async function member(role: MembershipRole, onlyBranch?: string): Promise<string> {
    const userId = await createTestUser();
    users.push(userId);
    const membershipId = randomUUID();
    await as(async (tx) => {
      await tx.membership.create({ data: injected({ id: membershipId, userId, role, status: "ACTIVE" }) });
      if (onlyBranch === undefined) return;
      await tx.membership.update({ where: { id: membershipId }, data: { branchScope: "SELECTED" } });
      await tx.membershipBranch.deleteMany({ where: { membershipId } });
      await tx.membershipBranch.create({ data: injected({ id: randomUUID(), membershipId, branchId: onlyBranch }) });
    });
    return issueAccessToken({ sub: userId, membershipId, tenantId: clinic.tenantId, role });
  }

  beforeAll(async () => {
    process.env["ATTACHMENTS_STORAGE_ROOT"] ??= process.cwd();
    clinic = await seedClinic();
    branchB = randomUUID();
    suspended = randomUUID();
    await as(async (tx) => {
      for (const [id, prefix] of [[branchB, "B"], [suspended, "S"]] as const) {
        await tx.branch.create({ data: injected({ id, name: prefix, address: "Giza", phone: "+201000000001", receiptPrefix: prefix, invoicePrefix: prefix }) });
      }
      await tx.scheduleTemplate.create({
        data: injected({ id: randomUUID(), branchId: suspended, doctorId: clinic.doctorId, weekday: 3, startTime: new Date("1970-01-01T09:00:00Z"), endTime: new Date("1970-01-01T10:00:00Z"), validFrom: new Date("2020-01-01") }),
      });
    });
    rows.a = await booked(clinic.branchId, `${PAST}T08:00:00Z`);
    rows.suspendedPast = await booked(suspended, `${PAST}T09:00:00Z`);
    rows.suspendedLater = await booked(suspended, `${WEDNESDAY}T07:00:00Z`);
    await as((tx) => tx.branch.update({ where: { id: suspended }, data: { status: "SUSPENDED", suspendedAt: new Date(), suspensionReason: "limit lowered" } }));

    tokens.admin = await member("ADMIN");
    tokens.scopedToB = await member("RECEPTIONIST", branchB);

    app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: false });
    app.useGlobalPipes(refusingValidationPipe());
    await app.listen(0);
    baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await app?.close();
    await teardownClinic(clinic);
    for (const userId of users) await deleteTestUser(userId);
  });

  const ids = (body: Record<string, unknown>, key: string) => new Set((body[key] as { appointmentId: string }[]).map((r) => r.appointmentId));

  test("its rows before the suspension appear in the lists of whoever holds every branch", async () => {
    expect(ids(await get("admin", `/queue/today?date=${PAST}`), "entries")).toEqual(new Set([rows.a, rows.suspendedPast]));
    expect(ids(await get("admin", `/schedule/day/bookings?date=${PAST}`), "bookings")).toEqual(new Set([rows.a, rows.suspendedPast]));
    const month = (await get("admin", `/schedule/month?month=${PAST.slice(0, 7)}`))["days"] as { date: string; total: number; finished: number }[];
    expect(month.filter((d) => d.date === PAST).reduce((n, d) => n + d.total + d.finished, 0)).toBe(2);
  });

  test("its rows dated after the suspension do not", async () => {
    expect(ids(await get("admin", `/queue/today?date=${WEDNESDAY}`), "entries").has(rows.suspendedLater)).toBe(false);
  });

  test("a caller who never held it does not read it", async () => {
    expect(ids(await get("scopedToB", `/queue/today?date=${PAST}`), "entries")).toEqual(new Set());
  });

  test("availability never offers its time, though its template stands", async () => {
    const { slots } = (await get("admin", `/availability?doctorId=${clinic.doctorId}&serviceId=${clinic.serviceId}&date=${WEDNESDAY}`)) as unknown as { slots: { branchId: string }[] };
    expect(slots.some((s) => s.branchId === suspended)).toBe(false);
  });
});
