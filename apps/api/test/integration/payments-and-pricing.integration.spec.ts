import { randomUUID } from "node:crypto";
import { Module, ValidationPipe } from "@nestjs/common";
import { APP_INTERCEPTOR, NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import type { AddressInfo } from "node:net";
import { ActorContextInterceptor } from "../../src/common/actor-context.interceptor.ts";
import { issueAccessToken } from "../../src/modules/auth/jwt.ts";
import { ClinicalController } from "../../src/modules/clinical/clinical.controller.ts";
import { BillingController } from "../../src/modules/billing/billing.controller.ts";
import { BillingActionsController } from "../../src/modules/billing/billing-actions.controller.ts";
import { writeChargeForVisit } from "../../src/modules/billing/charge-from-visit.ts";
import { prisma } from "../../src/prisma/client.ts";
import { injected } from "../../src/prisma/injected.ts";
import { withTenant } from "../../src/prisma/with-tenant.ts";
import { ThrottlingModule } from "../../src/common/throttling.module.ts";
import {
  actorFor,
  createTestUser,
  deleteTestUser,
  seedClinic,
  teardownClinic,
  type ClinicFixture,
} from "./fixtures.ts";

/**
 * Doctor pricing and the payments screen — the founder's rulings R1 and R2, 2026-09-11.
 *
 * The guards, all proven at the route rather than in a service call:
 *
 *   - **a doctor without «يُسمح له بتعديل الأسعار» gets 403** on the adjustment route, and is told
 *     `mayAdjust: false` so the control never renders;
 *   - an allowed doctor's adjustment becomes a **signed ADJUSTMENT line** at completion, and the
 *     snapshotted lines are untouched;
 *   - **an admin cannot collect** — `payments.record` refuses at the guard — while still reading
 *     the whole screen;
 *   - a doctor collects only with «يحصّل المدفوعات بنفسه», and only for their own patients.
 */

@Module({
  // Recording a payment is rate-limited (4b), so its guard needs the throttler options in scope.
  imports: [ThrottlingModule],
  controllers: [ClinicalController, BillingController, BillingActionsController],
  providers: [{ provide: APP_INTERCEPTOR, useClass: ActorContextInterceptor }],
})
class PaymentsTestModule {}

let slot = 0;
/** A distinct past half-hour per appointment: `no_double_booking` is a live constraint. */
function nextSlot(): Date {
  slot += 1;
  return new Date(Date.now() - slot * 24 * 60 * 60_000);
}

describe("doctor pricing and the payments screen", () => {
  let app: NestExpressApplication;
  let baseUrl: string;
  let clinic: ClinicFixture;
  let doctorToken = "";
  let receptionToken = "";
  let adminToken = "";
  let colleague: { userId: string; doctorId: string; chargeId: string };

  const call = async (token: string, method: string, url: string, body?: unknown): Promise<Response> =>
    fetch(`${baseUrl}${url}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  const liveAppointment = async (doctorId: string): Promise<string> => {
    const status = "IN_CONSULTATION" as const;
    const id = randomUUID();
    await withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) => {
      const start = nextSlot();
      await tx.appointment.create({
        data: injected({
          id,
          patientId: clinic.patientId,
          doctorId,
          serviceId: clinic.serviceId,
          quotedPriceMinor: 100_000,
          scheduledStart: start,
          scheduledEnd: new Date(start.getTime() + 30 * 60_000),
          status,
          source: "RECEPTION",
          arrivedAt: start,
          waitingStartedAt: start,
          consultationStartedAt: start,
          createdBy: clinic.userId,
          updatedBy: clinic.userId,
          allowOverlap: true,
        }),
      });
    });
    return id;
  };

  /** A draft the doctor owns, opened the way the screen opens one. */
  const openDraft = async (appointmentId: string): Promise<string> => {
    const response = await call(doctorToken, "POST", `/appointments/${appointmentId}/visit/draft`);
    return ((await response.json()) as { id: string }).id;
  };

  const setFlags = async (doctorId: string, flags: Record<string, boolean>): Promise<void> => {
    await withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) => {
      await tx.doctor.update({ where: { id: doctorId }, data: flags });
    });
  };

  /** R1 as amended: the optional cap on the pricing permission. Null on both means unlimited. */
  const setCap = async (
    doctorId: string,
    cap: { percent: number | null; minor: number | null },
  ): Promise<void> => {
    await withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) => {
      await tx.doctor.update({
        where: { id: doctorId },
        data: { priceAdjustmentCapPercent: cap.percent, priceAdjustmentCapMinor: cap.minor },
      });
    });
  };

  beforeAll(async () => {
    clinic = await seedClinic();
    await withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) => {
      await tx.service.update({ where: { id: clinic.serviceId }, data: { priceMinor: 100_000 } });
    });

    const claims = { sub: clinic.userId, tenantId: clinic.tenantId } as const;
    doctorToken = await issueAccessToken({ ...claims, membershipId: clinic.membershipId, role: "DOCTOR" });

    // Reception and admin as separate memberships of the same person: the fixture user is the only
    // one with an audit-safe id, and the role in the claim is what the matrix reads.
    const [receptionMembership, adminMembership] = await withTenant(
      clinic.tenantId,
      actorFor(clinic.userId),
      async (tx) => {
        const ids = [randomUUID(), randomUUID()] as const;
        await tx.membership.create({
          data: injected({ id: ids[0], userId: clinic.userId, role: "RECEPTIONIST", status: "ACTIVE" }),
        });
        await tx.membership.create({
          data: injected({ id: ids[1], userId: clinic.userId, role: "ADMIN", status: "ACTIVE" }),
        });
        return ids;
      },
    );
    receptionToken = await issueAccessToken({ ...claims, membershipId: receptionMembership, role: "RECEPTIONIST" });
    adminToken = await issueAccessToken({ ...claims, membershipId: adminMembership, role: "ADMIN" });

    app = await NestFactory.create<NestExpressApplication>(PaymentsTestModule, { logger: false });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.listen(0);
    baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;

    colleague = await seedColleagueWithCharge();
  });

  /** A second doctor in the same clinic, with a completed visit and a charge of their own. */
  async function seedColleagueWithCharge(): Promise<{ userId: string; doctorId: string; chargeId: string }> {
    const userId = await createTestUser();
    return withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) => {
      const membershipId = randomUUID();
      await tx.membership.create({ data: injected({ id: membershipId, userId, role: "DOCTOR", status: "ACTIVE" }) });
      const doctorId = randomUUID();
      await tx.doctor.create({
        data: injected({
          id: doctorId,
          membershipId,
          specialty: "General",
          licenseNumber: `LIC-${doctorId.slice(0, 8)}`,
          title: "Dr.",
        }),
      });

      const start = new Date(Date.now() - 400 * 60 * 60_000);
      const appointmentId = randomUUID();
      await tx.appointment.create({
        data: injected({
          id: appointmentId,
          patientId: clinic.patientId,
          doctorId,
          serviceId: clinic.serviceId,
          scheduledStart: start,
          scheduledEnd: new Date(start.getTime() + 30 * 60_000),
          status: "COMPLETED",
          source: "RECEPTION",
          createdBy: clinic.userId,
          updatedBy: clinic.userId,
          allowOverlap: true,
        }),
      });
      const visitId = randomUUID();
      await tx.visit.create({
        data: injected({
          id: visitId,
          patientId: clinic.patientId,
          doctorId,
          appointmentId,
          status: "COMPLETED",
          createdBy: clinic.userId,
        }),
      });
      await tx.visitProcedure.create({
        data: injected({
          id: randomUUID(),
          visitId,
          serviceId: clinic.serviceId,
          quantity: 1,
          unitPriceMinor: 100_000,
          source: "RECEPTION",
          recordedByUserId: clinic.userId,
        }),
      });
      const chargeId = await writeChargeForVisit(tx, visitId, clinic.patientId, appointmentId, { actor: actorFor(clinic.userId) });
      return { userId, doctorId, chargeId: chargeId as string };
    });
  }

  afterAll(async () => {
    await app?.close();
    await teardownClinic(clinic);
    await deleteTestUser(colleague.userId);
    await prisma.$disconnect();
  });

  describe("R1 — the doctor's adjustment", () => {
    test("a doctor without the flag is refused at the route, and told the control is not theirs", async () => {
      await setFlags(clinic.doctorId, { mayAdjustPrices: false });
      const appointmentId = await liveAppointment(clinic.doctorId);
      const visitId = await openDraft(appointmentId);

      const read = await call(doctorToken, "GET", `/appointments/${appointmentId}/visit/${visitId}/pricing`);
      const pricing = (await read.json()) as { subtotalMinor: number; mayAdjust: boolean };
      // The total is still shown — seeing what a visit costs is not the same act as changing it.
      expect(pricing).toMatchObject({ subtotalMinor: 100_000, mayAdjust: false });

      const refused = await call(doctorToken, "PUT", `/appointments/${appointmentId}/visit/${visitId}/pricing`, {
        adjustmentMinor: -20_000,
        reason: "regular patient",
      });
      expect(refused.status).toBe(403);
      expect(await refused.json()).toMatchObject({ code: "PRICE_ADJUSTMENT_NOT_ALLOWED" });

      const after = await withTenant(clinic.tenantId, actorFor(clinic.userId), (tx) =>
        tx.visit.findFirstOrThrow({ where: { id: visitId }, select: { priceAdjustmentMinor: true } }),
      );
      expect(after.priceAdjustmentMinor).toBeNull();
    });

    test("an allowed doctor moves the total, and who and when are recorded", async () => {
      await setFlags(clinic.doctorId, { mayAdjustPrices: true });
      const appointmentId = await liveAppointment(clinic.doctorId);
      const visitId = await openDraft(appointmentId);

      const saved = await call(doctorToken, "PUT", `/appointments/${appointmentId}/visit/${visitId}/pricing`, {
        adjustmentMinor: -20_000,
        reason: "regular patient",
      });
      expect(saved.status).toBe(200);
      expect(await saved.json()).toMatchObject({
        subtotalMinor: 100_000,
        adjustmentMinor: -20_000,
        totalMinor: 80_000,
        mayAdjust: true,
      });

      const row = await withTenant(clinic.tenantId, actorFor(clinic.userId), (tx) =>
        tx.visit.findFirstOrThrow({
          where: { id: visitId },
          select: { priceAdjustedByUserId: true, priceAdjustedAt: true, priceAdjustmentReason: true },
        }),
      );
      expect(row.priceAdjustedByUserId).toBe(clinic.userId);
      expect(row.priceAdjustmentReason).toBe("regular patient");
      expect(row.priceAdjustedAt).not.toBeNull();
    });

    test("completion writes it as a signed line and leaves the snapshots alone", async () => {
      await setFlags(clinic.doctorId, { mayAdjustPrices: true });
      const appointmentId = await liveAppointment(clinic.doctorId);
      const visitId = await openDraft(appointmentId);
      await call(doctorToken, "PUT", `/appointments/${appointmentId}/visit/${visitId}/pricing`, {
        adjustmentMinor: -20_000,
        reason: null,
      });

      const charge = await withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) => {
        const chargeId = await writeChargeForVisit(tx, visitId, clinic.patientId, appointmentId, { actor: actorFor(clinic.userId) });
        return tx.visitCharge.findFirstOrThrow({
          where: { id: chargeId as string },
          select: {
            subtotalMinor: true,
            lines: {
              select: { source: true, unitPriceMinor: true, adjustedByUserId: true },
              orderBy: { createdAt: "asc" },
            },
          },
        });
      });

      // **The guard.** The catalogue line still says 100,000 — what the patient was told the
      // consultation costs — and the discount the doctor gave is a second line saying so.
      expect(charge.subtotalMinor).toBe(80_000);
      expect(charge.lines).toEqual([
        { source: "CATALOGUE", unitPriceMinor: 100_000, adjustedByUserId: null },
        { source: "ADJUSTMENT", unitPriceMinor: -20_000, adjustedByUserId: clinic.userId },
      ]);
    });

    test("a cap refuses a larger adjustment at the route, and names the limit", async () => {
      // R1 as amended. 10% of a 100,000 visit is 10,000; the flat cap is 30,000, so the percentage
      // binds — the same LEAST-ignoring-nulls rule the discount ceiling follows.
      await setFlags(clinic.doctorId, { mayAdjustPrices: true });
      await setCap(clinic.doctorId, { percent: 10, minor: 30_000 });
      const appointmentId = await liveAppointment(clinic.doctorId);
      const visitId = await openDraft(appointmentId);

      const read = await call(doctorToken, "GET", `/appointments/${appointmentId}/visit/${visitId}/pricing`);
      // The limit is on the screen before it is hit, rather than only in the refusal.
      expect(await read.json()).toMatchObject({ mayAdjust: true, capMinor: 10_000 });

      const refused = await call(doctorToken, "PUT", `/appointments/${appointmentId}/visit/${visitId}/pricing`, {
        adjustmentMinor: -20_000,
        reason: "goodwill",
      });
      expect(refused.status).toBe(403);
      expect(await refused.json()).toMatchObject({
        code: "PRICE_ADJUSTMENT_ABOVE_CAP",
        params: { limit: 10_000, actual: 20_000 },
      });

      // The cap is a distance, not a direction: raising by more is refused too.
      const upward = await call(doctorToken, "PUT", `/appointments/${appointmentId}/visit/${visitId}/pricing`, {
        adjustmentMinor: 20_000,
      });
      expect(upward.status).toBe(403);

      // And within it is allowed, so the cap is not simply refusing everything.
      const within = await call(doctorToken, "PUT", `/appointments/${appointmentId}/visit/${visitId}/pricing`, {
        adjustmentMinor: -9_000,
      });
      expect(within.status).toBe(200);
    });

    test("the database refuses it too, whatever writes the row", async () => {
      // **The half a route check cannot give.** A service-layer rule passes on a machine where the
      // migration never ran, and never sees the seed, direct SQL, or a future bulk import.
      await setFlags(clinic.doctorId, { mayAdjustPrices: true });
      await setCap(clinic.doctorId, { percent: null, minor: 5_000 });
      const appointmentId = await liveAppointment(clinic.doctorId);
      const visitId = await openDraft(appointmentId);

      const write = withTenant(clinic.tenantId, actorFor(clinic.userId), (tx) =>
        tx.visit.updateMany({
          where: { id: visitId },
          data: {
            priceAdjustmentMinor: -50_000,
            priceAdjustedByUserId: clinic.userId,
            priceAdjustedAt: new Date(),
          },
        }),
      );
      await expect(write).rejects.toThrow(/exceeds this doctor's cap/);
    });

    test("no cap set means unlimited, which is what every doctor had before the cap existed", async () => {
      await setFlags(clinic.doctorId, { mayAdjustPrices: true });
      await setCap(clinic.doctorId, { percent: null, minor: null });
      const appointmentId = await liveAppointment(clinic.doctorId);
      const visitId = await openDraft(appointmentId);

      const saved = await call(doctorToken, "PUT", `/appointments/${appointmentId}/visit/${visitId}/pricing`, {
        adjustmentMinor: -90_000,
      });
      expect(saved.status).toBe(200);
      expect(await saved.json()).toMatchObject({ capMinor: null, adjustmentMinor: -90_000 });
    });

    test("clearing the adjustment removes it whole", async () => {
      await setCap(clinic.doctorId, { percent: null, minor: null });
      await setFlags(clinic.doctorId, { mayAdjustPrices: true });
      const appointmentId = await liveAppointment(clinic.doctorId);
      const visitId = await openDraft(appointmentId);
      await call(doctorToken, "PUT", `/appointments/${appointmentId}/visit/${visitId}/pricing`, {
        adjustmentMinor: 15_000,
        reason: "after hours",
      });

      const cleared = await call(doctorToken, "PUT", `/appointments/${appointmentId}/visit/${visitId}/pricing`, {
        adjustmentMinor: null,
      });
      expect(await cleared.json()).toMatchObject({ adjustmentMinor: null, totalMinor: 100_000 });

      const row = await withTenant(clinic.tenantId, actorFor(clinic.userId), (tx) =>
        tx.visit.findFirstOrThrow({
          where: { id: visitId },
          select: { priceAdjustmentReason: true, priceAdjustedByUserId: true, priceAdjustedAt: true },
        }),
      );
      // The CHECK refuses half an adjustment, so clearing has to clear all four columns.
      expect(row).toEqual({
        priceAdjustmentReason: null,
        priceAdjustedByUserId: null,
        priceAdjustedAt: null,
      });
    });
  });

  describe("R2 — who may see the money and who may take it", () => {
    test("an admin reads the whole screen and cannot collect", async () => {
      const overview = await call(adminToken, "GET", "/payments/overview");
      expect(overview.status).toBe(200);
      const body = (await overview.json()) as { mayCollect: boolean; charges: unknown[] };
      expect(body.mayCollect).toBe(false);

      const refused = await call(adminToken, "POST", "/payments", {
        chargeId: colleague.chargeId,
        patientId: clinic.patientId,
        amountMinor: 10_000,
        method: "CASH",
      });
      // Refused by the capability matrix at the guard, before any handler runs.
      expect(refused.status).toBe(403);
    });

    test("reception collects", async () => {
      const taken = await call(receptionToken, "POST", "/payments", {
        chargeId: colleague.chargeId,
        patientId: clinic.patientId,
        amountMinor: 10_000,
        method: "CASH",
      });
      expect(taken.status).toBe(201);
      expect(await taken.json()).toMatchObject({ amountMinor: 10_000, method: "CASH" });
    });

    /**
     * **R-A's guard at the wire, 2026-09-14: desk overpayment → 422.**
     *
     * Well formed and refusable on content, like the payer split — not 400, which is reserved for a
     * shape the server never offered, and not 403, which is about the person.
     */
    test("more than the charge still owes is refused with 422 and the balance", async () => {
      const appointmentId = await liveAppointment(clinic.doctorId);
      const visitId = await openDraft(appointmentId);
      const chargeId = await withTenant(clinic.tenantId, actorFor(clinic.userId), (tx) =>
        writeChargeForVisit(tx, visitId, clinic.patientId, appointmentId, { actor: actorFor(clinic.userId) }),
      );

      const tooMuch = await call(receptionToken, "POST", "/payments", {
        chargeId,
        patientId: clinic.patientId,
        amountMinor: 150_000,
        method: "CASH",
      });
      expect(tooMuch.status).toBe(422);
      expect(await tooMuch.json()).toMatchObject({
        code: "PAYMENT_EXCEEDS_BALANCE",
        params: { limit: 100_000, actual: 150_000 },
      });

      // The whole balance still goes through: the refusal is about the excess, not about the act.
      const exact = await call(receptionToken, "POST", "/payments", {
        chargeId,
        patientId: clinic.patientId,
        amountMinor: 100_000,
        method: "CASH",
      });
      expect(exact.status).toBe(201);
    });

    test("a doctor without the collection flag is refused; with it, they collect", async () => {
      await setFlags(clinic.doctorId, { collectsPayments: false });
      const appointmentId = await liveAppointment(clinic.doctorId);
      const visitId = await openDraft(appointmentId);
      const chargeId = await withTenant(clinic.tenantId, actorFor(clinic.userId), (tx) =>
        writeChargeForVisit(tx, visitId, clinic.patientId, appointmentId, { actor: actorFor(clinic.userId) }),
      );

      const body = { chargeId, patientId: clinic.patientId, amountMinor: 5_000, method: "CASH" };
      const refused = await call(doctorToken, "POST", "/payments", body);
      expect(refused.status).toBe(403);
      expect(await refused.json()).toMatchObject({ code: "COLLECTION_NOT_ALLOWED" });

      await setFlags(clinic.doctorId, { collectsPayments: true });
      const allowed = await call(doctorToken, "POST", "/payments", body);
      expect(allowed.status).toBe(201);
    });

    test("a doctor collects for their own patients and not a colleague's", async () => {
      await setFlags(clinic.doctorId, { collectsPayments: true });
      const refused = await call(doctorToken, "POST", "/payments", {
        chargeId: colleague.chargeId,
        patientId: clinic.patientId,
        amountMinor: 5_000,
        method: "CASH",
      });
      // `own` is enforced by narrowing the query, so a colleague's charge is simply not there.
      expect(refused.status).toBe(404);
    });

    test("a doctor's screen holds their own patients' charges, not the clinic's", async () => {
      const overview = await call(doctorToken, "GET", "/payments/overview");
      const body = (await overview.json()) as { charges: { chargeId: string }[]; mayCollect: boolean };
      expect(body.mayCollect).toBe(true);
      expect(body.charges.some((charge) => charge.chargeId === colleague.chargeId)).toBe(false);
    });

    test("the adjustments an admin oversees are on the screen, which is what replaced the queue", async () => {
      const overview = await call(adminToken, "GET", "/payments/overview");
      const body = (await overview.json()) as {
        adjustments: { amountMinor: number; doctorName: string }[];
      };
      expect(body.adjustments.length).toBeGreaterThan(0);
      expect(body.adjustments.some((row) => row.amountMinor === -20_000)).toBe(true);
    });
  });
});
