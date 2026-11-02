// Branches step 5e: GET /reports/branches. Each row equals that branch's filtered /reports/payments, the rows sum to
// the «كل الفروع» report, and the read set (scope, header, suspended history, a doctor's own figures) governs which rows.
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { AppModule } from "../../src/app.module.ts";
import { todayInClinic } from "../../src/common/clinic-time.ts";
import { refusingValidationPipe } from "../../src/common/validation-pipe.ts";
import type { MembershipRole } from "../../src/generated/prisma/enums.ts";
import { issueAccessToken } from "../../src/modules/auth/jwt.ts";
import { injected } from "../../src/prisma/injected.ts";
import { type TransactionClient, withTenant } from "../../src/prisma/with-tenant.ts";
import { actorFor, createTestUser, deleteTestUser, seedClinic, teardownClinic, type ClinicFixture } from "./fixtures.ts";

interface Row { branchId: string; suspended: boolean; collectedMinor: number; chargedMinor: number; outstandingMinor: number; charges: number }
interface Payments { collectedMinor: number; outstandingMinor: number; byDoctor: { chargedMinor: number; charges: number }[] }

const LAST_MONTH = ((): string => {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - 1);
  return d.toISOString().slice(0, 7);
})();

describe("the comparison per branch (step 5e)", () => {
  let app: NestExpressApplication;
  let baseUrl = "";
  let clinic: ClinicFixture;
  let branchA = "";
  let branchB = "";
  let suspended = "";
  let thisMonth = "";
  const users: string[] = [];
  const tokens = { admin: "", scopedToB: "", doctor: "" };

  const as = <T>(work: (tx: TransactionClient) => Promise<T>): Promise<T> => withTenant(clinic.tenantId, actorFor(clinic.userId), work);
  const get = async <T>(who: keyof typeof tokens, path: string, branch?: string): Promise<T> => {
    const response = await fetch(`${baseUrl}${path}`, { headers: { authorization: `Bearer ${tokens[who]}`, ...(branch === undefined ? {} : { "x-branch-id": branch }) } });
    expect({ path, status: response.status }).toEqual({ path, status: 200 });
    return (await response.json()) as T;
  };
  const rows = async (who: keyof typeof tokens, on: string, branch?: string): Promise<Row[]> =>
    (await get<{ branches: Row[] }>(who, `/reports/branches?period=MONTH&on=${on}`, branch)).branches;
  const figures = (p: Payments) => ({
    collectedMinor: p.collectedMinor,
    chargedMinor: p.byDoctor.reduce((t, d) => t + d.chargedMinor, 0),
    outstandingMinor: p.outstandingMinor,
    charges: p.byDoctor.reduce((t, d) => t + d.charges, 0),
  });
  const pick = ({ collectedMinor, chargedMinor, outstandingMinor, charges }: Row) => ({ collectedMinor, chargedMinor, outstandingMinor, charges });

  /** A completed visit in `branchId` by the fixture's doctor, charged `priceMinor`, with `paidMinor` received against it. */
  let slot = 0;
  async function chargedVisit(branchId: string, priceMinor: number, paidMinor: number): Promise<void> {
    await as(async (tx) => {
      const appointmentId = randomUUID();
      const start = new Date(Date.now() - 3 * 3_600_000 - slot++ * 10 * 60_000);
      await tx.appointment.create({ data: injected({ id: appointmentId, branchId, patientId: clinic.patientId, doctorId: clinic.doctorId, serviceId: clinic.serviceId,
        scheduledStart: start, scheduledEnd: new Date(start.getTime() + 60_000), status: "COMPLETED", source: "RECEPTION", createdBy: clinic.userId, updatedBy: clinic.userId }) });
      const visitId = randomUUID();
      await tx.visit.create({ data: injected({ id: visitId, patientId: clinic.patientId, doctorId: clinic.doctorId, appointmentId, status: "DRAFT", createdBy: clinic.userId }) });
      const chargeId = randomUUID();
      await tx.visitCharge.create({ data: injected({ id: chargeId, visitId, patientId: clinic.patientId, subtotalMinor: priceMinor }) });
      await tx.visitChargeLine.create({ data: injected({ id: randomUUID(), chargeId, nameSnapshot: "consultation", unitPriceMinor: priceMinor, source: "AD_HOC" }) });
      if (paidMinor > 0) {
        await tx.payment.create({ data: injected({ id: randomUUID(), branchId, patientId: clinic.patientId, visitId, chargeId, amountMinor: paidMinor, method: "CASH", status: "PAID",
          receiptDate: new Date(`${todayInClinic(tenantZone)}T00:00:00Z`), paidAt: new Date() }) });
      }
    });
  }
  let tenantZone = "";
  const visitless = (branchId: string, day: string, amountMinor: number) =>
    as((tx) => tx.payment.create({ data: injected({ id: randomUUID(), branchId, patientId: clinic.patientId, amountMinor, method: "CASH", status: "PAID", receiptDate: new Date(`${day}T00:00:00Z`), paidAt: new Date(`${day}T10:00:00Z`) }) }));
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
    branchA = clinic.branchId;
    branchB = randomUUID();
    suspended = randomUUID();
    await as(async (tx) => {
      for (const [id, p] of [[branchB, "B"], [suspended, "S"]] as const) {
        await tx.branch.create({ data: injected({ id, name: p, address: "Giza", phone: "+201000000001", receiptPrefix: p, invoicePrefix: p }) });
      }
    });
    tenantZone = (await as((tx) => tx.tenant.findUniqueOrThrow({ where: { id: clinic.tenantId }, select: { timezone: true } }))).timezone;
    thisMonth = todayInClinic(tenantZone).slice(0, 7);
    await as((tx) => tx.scheduleTemplate.create({ data: injected({ id: randomUUID(), branchId: branchB, doctorId: clinic.doctorId, weekday: 6,
      startTime: new Date("1970-01-01T06:00:00Z"), endTime: new Date("1970-01-01T07:00:00Z"), validFrom: new Date("2020-01-01") }) }));
    await chargedVisit(branchA, 900, 300);
    await chargedVisit(branchB, 500, 0);
    await visitless(branchB, todayInClinic(tenantZone), 200);
    await visitless(suspended, `${LAST_MONTH}-12`, 4_000);
    await as((tx) => tx.branch.update({ where: { id: suspended }, data: { status: "SUSPENDED", suspendedAt: new Date(), suspensionReason: "limit lowered" } }));

    tokens.admin = await member("ADMIN");
    tokens.scopedToB = await member("ADMIN", branchB);
    tokens.doctor = await issueAccessToken({ sub: clinic.userId, membershipId: clinic.membershipId, tenantId: clinic.tenantId, role: "DOCTOR" });

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

  test("each active branch's row equals that branch's filtered payments report", async () => {
    const all = await rows("admin", thisMonth);
    for (const branch of [branchA, branchB]) {
      const filtered = figures(await get<Payments>("admin", `/reports/payments?period=MONTH&on=${thisMonth}`, branch));
      expect({ branch, ...pick(all.find((r) => r.branchId === branch)!) }).toEqual({ branch, ...filtered });
    }
    expect(pick(all.find((r) => r.branchId === branchA)!)).toEqual({ collectedMinor: 300, chargedMinor: 900, outstandingMinor: 600, charges: 1 });
    expect(pick(all.find((r) => r.branchId === branchB)!)).toEqual({ collectedMinor: 200, chargedMinor: 500, outstandingMinor: 500, charges: 1 });
  });

  test("the rows sum to the «كل الفروع» report, the suspended branch's past month included", async () => {
    for (const on of [thisMonth, LAST_MONTH]) {
      const total = figures(await get<Payments>("admin", `/reports/payments?period=MONTH&on=${on}`));
      const sum = (await rows("admin", on)).reduce((t, r) => ({ collectedMinor: t.collectedMinor + r.collectedMinor, chargedMinor: t.chargedMinor + r.chargedMinor,
        outstandingMinor: t.outstandingMinor + r.outstandingMinor, charges: t.charges + r.charges }), { collectedMinor: 0, chargedMinor: 0, outstandingMinor: 0, charges: 0 });
      expect({ on, ...sum }).toEqual({ on, ...total });
    }
    const past = await rows("admin", LAST_MONTH);
    expect(past.find((r) => r.branchId === suspended)).toMatchObject({ suspended: true, collectedMinor: 4_000 });
  });

  test("a caller scoped to one branch gets that branch's row only, and a named branch narrows to it", async () => {
    expect((await rows("scopedToB", thisMonth)).map((r) => r.branchId)).toEqual([branchB]);
    expect((await rows("admin", thisMonth, branchA)).map((r) => r.branchId)).toEqual([branchA]);
  });

  test("a doctor with own reports sees per-branch figures for themselves only", async () => {
    const response = await get<{ scope: string; branches: Row[] }>("doctor", `/reports/branches?period=MONTH&on=${thisMonth}`);
    expect(response.scope).toBe("OWN");
    expect(pick(response.branches.find((r) => r.branchId === branchB)!)).toEqual({ collectedMinor: 0, chargedMinor: 500, outstandingMinor: 500, charges: 1 });
  });
});
