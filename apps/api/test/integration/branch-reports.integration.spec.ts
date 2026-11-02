// Branches step 5d: the payments report and overview cover the read set; a suspended branch's receipts dated
// before its suspension stay in the month's total (ruled 2026-10-30: a gap in numbered receipts is a tax question).
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

const LAST_MONTH = ((): string => {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - 1);
  return d.toISOString().slice(0, 7);
})();

describe("the payments report and overview, per branch (step 5d)", () => {
  let app: NestExpressApplication;
  let baseUrl = "";
  let clinic: ClinicFixture;
  let branchA = "";
  let branchB = "";
  let suspended = "";
  let today = "";
  const users: string[] = [];
  const tokens = { admin: "", scopedToB: "" };

  const as = <T>(work: (tx: TransactionClient) => Promise<T>): Promise<T> => withTenant(clinic.tenantId, actorFor(clinic.userId), work);
  const get = async (who: keyof typeof tokens, path: string, branch?: string): Promise<Record<string, unknown>> => {
    const response = await fetch(`${baseUrl}${path}`, { headers: { authorization: `Bearer ${tokens[who]}`, ...(branch === undefined ? {} : { "x-branch-id": branch }) } });
    expect({ path, status: response.status }).toEqual({ path, status: 200 });
    return (await response.json()) as Record<string, unknown>;
  };
  const receipt = (branchId: string, day: string, amountMinor: number) =>
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
    const tenant = await as((tx) => tx.tenant.findUniqueOrThrow({ where: { id: clinic.tenantId }, select: { timezone: true } }));
    today = todayInClinic(tenant.timezone);
    await receipt(branchA, `${LAST_MONTH}-10`, 1_000);
    await receipt(branchB, `${LAST_MONTH}-11`, 2_000);
    await receipt(suspended, `${LAST_MONTH}-12`, 4_000);
    await receipt(branchA, today, 100);
    await receipt(branchB, today, 200);
    await as((tx) => tx.branch.update({ where: { id: suspended }, data: { status: "SUSPENDED", suspendedAt: new Date(), suspensionReason: "limit lowered" } }));

    tokens.admin = await member("ADMIN");
    tokens.scopedToB = await member("ADMIN", branchB);

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

  const collected = async (who: keyof typeof tokens, branch?: string) =>
    (await get(who, `/reports/payments?period=MONTH&on=${LAST_MONTH}`, branch))["collectedMinor"];

  test("a suspended branch's past receipts are in the month's total for whoever holds every branch", async () => {
    expect(await collected("admin")).toBe(7_000);
  });

  test("a selected branch reports only its own receipts", async () => {
    expect(await collected("admin", branchA)).toBe(1_000);
    expect(await collected("admin", branchB)).toBe(2_000);
  });

  test("a caller scoped to one branch reports only that branch, never another", async () => {
    expect(await collected("scopedToB")).toBe(2_000);
  });

  test("the index the month's receipts are read through exists", async () => {
    const found = await as((tx) => tx.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_indexes WHERE tablename = 'payments' AND indexname = 'payments_tenant_id_branch_id_receipt_date_idx'`);
    expect(found[0]!.n).toBe(1);
  });

  test("the day's overview lists the receipts of the read set only", async () => {
    const amounts = async (who: keyof typeof tokens, branch?: string) =>
      ((await get(who, "/payments/overview", branch))["receipts"] as { amountMinor: number }[]).map((r) => r.amountMinor).sort((a, b) => a - b);
    expect(await amounts("admin")).toEqual([100, 200]);
    expect(await amounts("admin", branchA)).toEqual([100]);
    expect(await amounts("scopedToB")).toEqual([200]);
  });
});
