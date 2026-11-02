// Branches on a migrated database (docs/BRANCHES-DESIGN.md §1–3): every clinic's default branch, the
// composite keys refusing another clinic's branch, derivation, numbering, currency and scope.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Prisma } from "../../src/generated/prisma/client.ts";
import { prisma } from "../../src/prisma/client.ts";
import { injected } from "../../src/prisma/injected.ts";
import { type TransactionClient, withTenant } from "../../src/prisma/with-tenant.ts";
import { branchPolicyOf } from "../../src/prisma/branch-stamped-models.ts";
import { actorFor, createTestUser, seedClinic, teardownClinic, type ClinicFixture } from "./fixtures.ts";

type Tx = TransactionClient;
const failure = (work: Promise<unknown>): Promise<string> =>
  work.then(
    () => "no error",
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  );

const as = <T>(clinic: ClinicFixture, work: (tx: Tx) => Promise<T>): Promise<T> =>
  withTenant(clinic.tenantId, actorFor(clinic.userId), work);

const defaultBranchOf = (clinic: ClinicFixture) =>
  as(clinic, (tx) => tx.branch.findFirstOrThrow({ where: { isDefault: true } }));

let minute = 0;
async function appointment(tx: Tx, clinic: ClinicFixture, extra: Record<string, unknown> = {}): Promise<string> {
  const id = randomUUID();
  minute += 30;
  const start = new Date(Date.UTC(2031, 0, 1, 6, 0) + minute * 60_000);
  await tx.appointment.create({
    data: injected({
      id,
      branchId: clinic.branchId,
      patientId: clinic.patientId,
      doctorId: clinic.doctorId,
      serviceId: clinic.serviceId,
      scheduledStart: start,
      scheduledEnd: new Date(start.getTime() + 30 * 60_000),
      status: "BOOKED",
      source: "RECEPTION",
      createdBy: clinic.userId,
      updatedBy: clinic.userId,
      ...extra,
    }),
  });
  return id;
}

async function visitChargeAndReceipt(tx: Tx, clinic: ClinicFixture, appointmentId: string) {
  const visitId = randomUUID();
  await tx.visit.create({
    data: injected({
      id: visitId,
      patientId: clinic.patientId,
      doctorId: clinic.doctorId,
      appointmentId,
      status: "DRAFT",
      createdBy: clinic.userId,
    }),
  });
  const charge = await tx.visitCharge.create({
    data: injected({ id: randomUUID(), visitId, patientId: clinic.patientId }),
    select: { id: true, branchId: true, invoiceNumber: true, currency: true },
  });
  const receipt = await tx.payment.create({
    data: injected({ id: randomUUID(), patientId: clinic.patientId, chargeId: charge.id, amountMinor: 500, method: "CASH", status: "PAID" }),
    select: { branchId: true, receiptNumber: true, currency: true },
  });
  const visit = await tx.visit.findUniqueOrThrow({ where: { id: visitId }, select: { branchId: true } });
  return { visit, charge, receipt };
}

describe("branches", () => {
  let clinic: ClinicFixture;
  let other: ClinicFixture;

  beforeAll(async () => {
    clinic = await seedClinic();
    other = await seedClinic();
  });

  afterAll(async () => {
    await teardownClinic(other);
    await teardownClinic(clinic);
    await prisma.$disconnect();
  });

  test("a new clinic is born with one default branch carrying its address, unprefixed", async () => {
    const branches = await as(clinic, (tx) => tx.branch.findMany());
    const tenant = await as(clinic, (tx) => tx.tenant.findUniqueOrThrow({ where: { id: clinic.tenantId } }));
    expect(branches).toHaveLength(1);
    expect(branches[0]).toMatchObject({
      isDefault: true,
      status: "ACTIVE",
      name: tenant.name,
      address: tenant.address,
      phone: tenant.phone,
      receiptPrefix: null,
      invoicePrefix: null,
      nextReceiptNumber: 1,
      nextInvoiceNumber: 1,
    });
  });

  describe("the database refuses another clinic's branch", () => {
    test("an exception naming another clinic's branch", async () => {
      const theirs = await defaultBranchOf(clinic);
      const message = await failure(
        as(other, (tx) =>
          tx.scheduleException.create({
            data: injected({ id: randomUUID(), date: new Date("2031-02-01"), type: "HOLIDAY", branchId: theirs.id, scope: "ONE_BRANCH" }),
          }),
        ),
      );
      expect(message).toContain("schedule_exceptions_tenant_id_branch_id_fkey");
    });

    test("an appointment moved into another clinic's branch", async () => {
      const theirs = await defaultBranchOf(clinic);
      const message = await failure(
        as(other, async (tx) => {
          const id = await appointment(tx, other);
          await tx.$executeRaw`UPDATE appointments SET branch_id = ${theirs.id}::uuid WHERE id = ${id}::uuid`;
        }),
      );
      expect(message).toContain("appointments_tenant_id_branch_id_fkey");
    });

    test("every stamped table carries the (tenant_id, branch_id) key, read from the registry", async () => {
      const schema = readFileSync(path.resolve(__dirname, "..", "..", "prisma", "schema.prisma"), "utf8");
      const tableOf = (model: string) => new RegExp(`^model ${model} \\{[\\s\\S]*?@@map\\("(\\w+)"\\)`, "m").exec(schema)?.[1];
      const stamped = Object.values(Prisma.ModelName).filter((m) => branchPolicyOf(m) === "stamped" && m !== "AuditLog");
      const missing: string[] = [];
      for (const model of stamped) {
        const table = tableOf(model);
        const rows = await prisma.$queryRaw<{ n: bigint }[]>`
          SELECT count(*) AS n FROM pg_constraint c
           WHERE c.contype = 'f' AND c.conrelid = ${table}::regclass AND c.confrelid = 'branches'::regclass
             AND (SELECT array_agg(a.attname::text ORDER BY a.attname) FROM pg_attribute a
                   WHERE a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)) = ARRAY['branch_id', 'tenant_id']`;
        if (Number(rows[0]?.n) !== 1) missing.push(`${model} (${String(table)})`);
      }
      expect(stamped.length).toBeGreaterThanOrEqual(7);
      expect(missing).toEqual([]);
    });
  });

  test("a visit, its charge and its receipt take the appointment's branch, and cannot disagree", async () => {
    const mine = await defaultBranchOf(other);
    const result = await as(other, async (tx) => visitChargeAndReceipt(tx, other, await appointment(tx, other)));
    expect(result.visit.branchId).toBe(mine.id);
    expect(result.charge.branchId).toBe(mine.id);
    expect(result.receipt.branchId).toBe(mine.id);
  });

  test("audit rows written from now on carry the row's branch", async () => {
    const mine = await defaultBranchOf(other);
    const id = await as(other, (tx) => appointment(tx, other));
    const audit = await as(other, (tx) => tx.auditLog.findFirstOrThrow({ where: { entityId: id, action: "CREATE" } }));
    expect(audit.branchId).toBe(mine.id);
  });

  test("a money row keeps its clinic's currency, on all five ledger tables", async () => {
    await as(other, (tx) => tx.tenant.update({ where: { id: other.tenantId }, data: { currency: "SAR" } }));
    const rows = await as(other, async (tx) => {
      const { charge } = await visitChargeAndReceipt(tx, other, await appointment(tx, other));
      const line = await tx.visitChargeLine.create({
        data: injected({ id: randomUUID(), chargeId: charge.id, nameSnapshot: "x-ray", unitPriceMinor: 900, source: "AD_HOC" }),
        select: { currency: true },
      });
      const payment = await tx.payment.create({
        data: injected({ id: randomUUID(), branchId: other.branchId, patientId: other.patientId, amountMinor: 100, method: "CASH", status: "PAID" }),
        select: { id: true, currency: true },
      });
      const adjustment = await tx.paymentAdjustment.create({
        data: injected({
          id: randomUUID(),
          paymentId: payment.id,
          adjustmentType: "CORRECTION",
          amountMinor: 0,
          reason: "branches spec",
          actorUserId: other.userId,
          previousStatus: "PAID",
          newStatus: "PAID",
        }),
        select: { currency: true },
      });
      const credit = await tx.patientCredit.create({
        data: injected({ id: randomUUID(), patientId: other.patientId, movement: "CREDIT", amountMinor: 100, actorUserId: other.userId, sourcePaymentId: payment.id }),
        select: { currency: true },
      });
      return [charge.currency, line.currency, payment.currency, adjustment.currency, credit.currency];
    });
    await as(other, (tx) => tx.tenant.update({ where: { id: other.tenantId }, data: { currency: "EGP" } }));
    expect(rows).toEqual(["SAR", "SAR", "SAR", "SAR", "SAR"]);
  });

  test("membership scope follows the role, and a receptionist starts in the default branch", async () => {
    const mine = await defaultBranchOf(other);
    const [adminUser, deskUser] = [await createTestUser(), await createTestUser()];
    const scopes = await as(other, async (tx) => {
      const member = (userId: string, role: "ADMIN" | "RECEPTIONIST") =>
        tx.membership.create({ data: injected<Prisma.MembershipUncheckedCreateInput>({ id: randomUUID(), userId, role, status: "ACTIVE" }) });
      const admin = await member(adminUser, "ADMIN");
      const desk = await member(deskUser, "RECEPTIONIST");
      const doctor = await tx.membership.findUniqueOrThrow({ where: { id: other.membershipId } });
      const deskBranches = await tx.membershipBranch.findMany({ where: { membershipId: desk.id } });
      const promoted = await tx.membership.update({ where: { id: desk.id }, data: { role: "ADMIN" } });
      return { admin: admin.branchScope, desk: desk.branchScope, doctor: doctor.branchScope, deskBranches, promoted: promoted.branchScope };
    });
    expect(scopes).toMatchObject({ admin: "ALL", desk: "SELECTED", doctor: "SCHEDULED", promoted: "ALL" });
    expect(scopes.deskBranches.map((row) => row.branchId)).toEqual([mine.id]);
  });

  describe("a row keeps the branch it names (nothing fills one in since stage 5)", () => {
    test("keeps the branch an appointment names", async () => {
      const mine = await defaultBranchOf(other);
      const id = await as(other, (tx) => appointment(tx, other, { branchId: mine.id }));
      const row = await as(other, (tx) => tx.appointment.findUniqueOrThrow({ where: { id }, select: { branchId: true } }));
      expect(row.branchId).toBe(mine.id);
    });

    test("keeps the branch a schedule template names", async () => {
      const mine = await defaultBranchOf(other);
      const created = await as(other, (tx) =>
        tx.scheduleTemplate.create({
          data: injected<Prisma.ScheduleTemplateUncheckedCreateInput>({
            id: randomUUID(),
            doctorId: other.doctorId,
            weekday: 1,
            startTime: new Date("1970-01-01T09:00:00Z"),
            endTime: new Date("1970-01-01T12:00:00Z"),
            validFrom: new Date("2031-01-01"),
            branchId: mine.id,
          }),
          select: { branchId: true },
        }),
      );
      expect(created.branchId).toBe(mine.id);
    });

    test("numbers a receipt that names its branch from that branch", async () => {
      const mine = await defaultBranchOf(other);
      const created = await as(other, (tx) =>
        tx.payment.create({
          data: injected<Prisma.PaymentUncheckedCreateInput>({
            id: randomUUID(),
            patientId: other.patientId,
            amountMinor: 1,
            method: "CASH",
            status: "PAID",
            branchId: mine.id,
          }),
          select: { branchId: true, receiptNumber: true },
        }),
      );
      expect(created.branchId).toBe(mine.id);
      expect(created.receiptNumber).toBe(mine.nextReceiptNumber);
    });
  });

  describe("with a second branch", () => {
    const PER_BRANCH = 4;
    let first: string;
    let second: string;
    let appointments: { first: string[]; second: string[] };

    beforeAll(async () => {
      first = (await defaultBranchOf(clinic)).id;
      const ids = await as(clinic, async (tx) => {
        const made: string[] = [];
        for (let i = 0; i < PER_BRANCH * 2 + 2; i += 1) made.push(await appointment(tx, clinic));
        return made;
      });
      second = randomUUID();
      await as(clinic, async (tx) => {
        await tx.branch.create({
          data: injected<Prisma.BranchUncheckedCreateInput>({ id: second, name: "Second", address: "Giza", phone: "+201000000001", receiptPrefix: "B", invoicePrefix: "B" }),
        });
        await tx.appointment.updateMany({ where: { id: { in: ids.slice(PER_BRANCH) } }, data: { branchId: second } });
      });
      appointments = { first: ids.slice(0, PER_BRANCH), second: ids.slice(PER_BRANCH) };
    });

    test("a row naming its branch is stored in it, in either branch", async () => {
      const ids = await as(clinic, async (tx) => [
        await appointment(tx, clinic, { branchId: first }),
        await appointment(tx, clinic, { branchId: second }),
      ]);
      const rows = await as(clinic, (tx) => tx.appointment.findMany({ where: { id: { in: ids } }, select: { id: true, branchId: true } }));
      expect(new Map(rows.map((r) => [r.id, r.branchId]))).toEqual(new Map([[ids[0], first], [ids[1], second]]));
    });

    test("a visit in a different branch from its appointment is refused", async () => {
      const message = await failure(
        as(clinic, (tx) =>
          tx.visit.create({
            data: injected<Prisma.VisitUncheckedCreateInput>({
              id: randomUUID(),
              patientId: clinic.patientId,
              doctorId: clinic.doctorId,
              appointmentId: appointments.first[0]!,
              status: "DRAFT",
              createdBy: clinic.userId,
              branchId: second,
            }),
          }),
        ),
      );
      expect(message).toContain("visits_appointment_id_branch_id_fkey");
    });

    test("invoice and receipt numbers stay gapless per branch when transactions overlap", async () => {
      // Gated, as in receipt-numbering.integration.spec.ts: without the barrier nothing overlaps.
      const work = [...appointments.first, ...appointments.second.slice(0, PER_BRANCH)];
      let open = 0;
      let release = (): void => {};
      const allOpen = new Promise<void>((resolve) => {
        release = resolve;
      });
      const results = await Promise.all(
        work.map((appointmentId) =>
          as(clinic, async (tx) => {
            open += 1;
            if (open === work.length) release();
            await allOpen;
            return visitChargeAndReceipt(tx, clinic, appointmentId);
          }),
        ),
      );

      const run = (branchId: string, pick: (r: (typeof results)[number]) => number) =>
        results.filter((r) => r.charge.branchId === branchId).map(pick).sort((a, b) => a - b);
      const oneTo = (n: number) => Array.from({ length: n }, (_, i) => i + 1);
      expect({
        firstInvoices: run(first, (r) => r.charge.invoiceNumber),
        firstReceipts: run(first, (r) => r.receipt.receiptNumber),
        secondInvoices: run(second, (r) => r.charge.invoiceNumber),
        secondReceipts: run(second, (r) => r.receipt.receiptNumber),
      }).toEqual({ firstInvoices: oneTo(PER_BRANCH), firstReceipts: oneTo(PER_BRANCH), secondInvoices: oneTo(PER_BRANCH), secondReceipts: oneTo(PER_BRANCH) });
    });

    test("a rolled-back charge burns no invoice number in its branch", async () => {
      const [failed, next] = appointments.second.slice(PER_BRANCH);
      await expect(
        as(clinic, async (tx) => {
          await visitChargeAndReceipt(tx, clinic, failed!);
          throw new Error("abandoned");
        }),
      ).rejects.toThrow("abandoned");
      const result = await as(clinic, (tx) => visitChargeAndReceipt(tx, clinic, next!));
      expect({ invoice: result.charge.invoiceNumber, receipt: result.receipt.receiptNumber }).toEqual({
        invoice: PER_BRANCH + 1,
        receipt: PER_BRANCH + 1,
      });
    });

    test("a receipt naming a branch other than its charge's is refused by the composite key", async () => {
      const { charge } = await as(clinic, async (tx) =>
        visitChargeAndReceipt(tx, clinic, await appointment(tx, clinic, { branchId: first })),
      );
      const message = await failure(
        as(clinic, (tx) =>
          tx.payment.create({
            data: injected<Prisma.PaymentUncheckedCreateInput>({ id: randomUUID(), patientId: clinic.patientId, chargeId: charge.id, amountMinor: 1, method: "CASH", status: "PAID", branchId: second }),
          }),
        ),
      );
      expect(message).toMatch(/fkey|foreign key/i);
    });
  });
});
