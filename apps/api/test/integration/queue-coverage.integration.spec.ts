import { randomUUID } from "node:crypto";
import { describeQueue } from "../../src/modules/queue/queue.queries.ts";
import type { CallerContext } from "../../src/modules/appointments/appointments.service.ts";
import { prisma } from "../../src/prisma/client.ts";
import { injected } from "../../src/prisma/injected.ts";
import { withTenant } from "../../src/prisma/with-tenant.ts";
import { actorFor, seedClinic, teardownClinic, type ClinicFixture } from "./fixtures.ts";
import { generateFixturePhone } from "../fixture-phone.ts";

/**
 * Insurance on the queue row. `PHASE-3.md` Q18, founder's ruling 2026-09-02.
 *
 * *"Reception decides about payment at the desk. If they have to open a second screen to find out
 * whether someone is covered, they won't — and the field we just built stays unread."*
 *
 * Two requirements, and this file is about both:
 *
 *   1. **An expired policy must read differently from no policy at all.** "Cover lapsed" and "cash
 *      patient" are different conversations, and the desk is where they happen.
 *   2. **No second request per row.** The board polls every five seconds (Q1).
 */
describe("insurance on the queue row", () => {
  let clinic: ClinicFixture;
  let caller: CallerContext;

  const DATE = "2026-09-02";
  const NOW = new Date("2026-09-02T09:00:00Z");
  const DAY_START = new Date("2026-09-02T00:00:00Z");
  const DAY_END = new Date("2026-09-03T00:00:00Z");

  let contactId: string;
  let slotCursor = 0;

  beforeAll(async () => {
    clinic = await seedClinic();
    caller = {
      tenantId: clinic.tenantId,
      actor: actorFor(clinic.userId),
      role: "RECEPTIONIST",
      membershipId: clinic.membershipId,
    };
    await withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) => {
      contactId = randomUUID();
      await tx.contact.create({
        data: injected({ id: contactId, phoneE164: generateFixturePhone() }),
      });
    });
  });

  afterAll(async () => {
    await teardownClinic(clinic);
    await prisma.$disconnect();
  });

  /** A patient on today's queue. Distinct slots: `no_double_booking` is a real constraint (D4). */
  const queuedPatient = async (name: string): Promise<string> => {
    const patientId = randomUUID();
    slotCursor += 1;
    const start = new Date(NOW.getTime() + slotCursor * 30 * 60_000);
    await withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) => {
      await tx.patient.create({
        data: injected({
          id: patientId,
          contactId,
          fullNameAr: name,
          phoneE164: generateFixturePhone(),
          relationshipToContact: "SELF",
          status: "ACTIVE",
        }),
      });
      await tx.appointment.create({
        data: injected({
          id: randomUUID(),
          patientId,
          doctorId: clinic.doctorId,
          serviceId: clinic.serviceId,
          scheduledStart: start,
          scheduledEnd: new Date(start.getTime() + 20 * 60_000),
          status: "ARRIVED",
          source: "RECEPTION",
          arrivedAt: start,
          createdBy: clinic.userId,
          updatedBy: clinic.userId,
        }),
      });
    });
    return patientId;
  };

  const givePolicy = async (
    patientId: string,
    insurerName: string,
    validFrom: string,
    validTo: string | null,
  ): Promise<void> => {
    await withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) => {
      const policyId = randomUUID();
      await tx.insurancePolicy.create({
        data: injected({
          id: policyId,
          contactId,
          insurerName,
          policyNumber: `POL-${policyId.slice(0, 8)}`,
          policyholderName: "حامل البوليصة",
          validFrom: new Date(`${validFrom}T00:00:00Z`),
          validTo: validTo === null ? null : new Date(`${validTo}T00:00:00Z`),
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

  const badgeFor = async (patientId: string): Promise<Record<string, unknown>> => {
    const board = await describeQueue(caller, {
      date: DATE,
      dayStart: DAY_START,
      dayEnd: DAY_END,
      now: NOW,
    });
    const entry = board.entries.find((row) => row.patientId === patientId);
    if (entry === undefined) throw new Error("patient is not on the queue");
    return entry.coverage as unknown as Record<string, unknown>;
  };

  describe("the three states reception actually needs to tell apart", () => {
    test("a live policy reads as covered, and names the insurer", async () => {
      const patientId = await queuedPatient("مريض مؤمَّن");
      await givePolicy(patientId, "MedRight Egypt", "2026-01-01", "2099-12-31");

      expect(await badgeFor(patientId)).toEqual({
        standing: "COVERED",
        insurerName: "MedRight Egypt",
      });
    });

    test("an expired policy reads as LAPSED, not as no cover", async () => {
      // The founder's first requirement, and the whole reason this is not a boolean. "Your cover
      // ended" and "you have no insurance with us" are different sentences to say to someone
      // standing at the desk.
      const patientId = await queuedPatient("مريض انتهت تغطيته");
      await givePolicy(patientId, "OldCover Co", "2020-01-01", "2021-12-31");

      expect(await badgeFor(patientId)).toEqual({
        standing: "LAPSED",
        insurerName: "OldCover Co",
      });
    });

    test("no policy at all reads as NONE, and carries no insurer name to render", async () => {
      const patientId = await queuedPatient("مريض نقدي");

      expect(await badgeFor(patientId)).toEqual({ standing: "NONE" });
    });

    test("LAPSED and NONE are genuinely distinguishable, which is the point", async () => {
      // Stated as its own assertion because it is the requirement, not an implementation detail:
      // if these two ever collapse into one value the screen silently loses a conversation.
      const lapsed = await queuedPatient("انتهت");
      await givePolicy(lapsed, "Gone Ltd", "2019-01-01", "2020-01-01");
      const none = await queuedPatient("لا يوجد");

      expect(await badgeFor(lapsed)).not.toEqual(await badgeFor(none));
    });
  });

  describe("precedence, when a patient has more than one policy", () => {
    test("a renewal beats the expired policy it replaced", async () => {
      // Order of insertion is deliberately expired-first, so a fold that simply took the last row
      // would get this wrong.
      const patientId = await queuedPatient("مريض جدّد");
      await givePolicy(patientId, "OldCover Co", "2020-01-01", "2021-12-31");
      await givePolicy(patientId, "NewCover Co", "2026-01-01", null);

      expect(await badgeFor(patientId)).toEqual({
        standing: "COVERED",
        insurerName: "NewCover Co",
      });
    });

    test("cover that has not started yet is not billable today, and is not called lapsed", async () => {
      // FUTURE folds into NONE. Both mean "do not bill the insurer today", which is the only
      // decision this badge supports -- but calling next year's cover "lapsed" would be a plain
      // lie at the desk. The profile shows it properly.
      const patientId = await queuedPatient("تغطية مستقبلية");
      await givePolicy(patientId, "NextYear Co", "2099-01-01", "2099-12-31");

      expect(await badgeFor(patientId)).toEqual({ standing: "NONE" });
    });

    test("an open-ended policy is covered", async () => {
      const patientId = await queuedPatient("تغطية مفتوحة");
      await givePolicy(patientId, "OpenEnded Co", "2026-01-01", null);

      expect(await badgeFor(patientId)).toEqual({
        standing: "COVERED",
        insurerName: "OpenEnded Co",
      });
    });
  });

  describe("no second request per row", () => {
    test("every badge on the board arrives in the one queue call", async () => {
      // The founder's second requirement. This is what makes a per-row fetch unnecessary rather
      // than merely discouraged: the data is already on the row the screen is rendering, so a
      // frontend that wanted a second request would have nothing to ask for.
      const covered = await queuedPatient("أ");
      const lapsed = await queuedPatient("ب");
      const none = await queuedPatient("ج");
      await givePolicy(covered, "Batch Insurer", "2026-01-01", null);
      await givePolicy(lapsed, "Batch Expired", "2020-01-01", "2020-12-31");

      const board = await describeQueue(caller, {
        date: DATE,
        dayStart: DAY_START,
        dayEnd: DAY_END,
        now: NOW,
      });

      const byId = new Map(board.entries.map((row) => [row.patientId, row.coverage]));
      expect(byId.get(covered)).toEqual({ standing: "COVERED", insurerName: "Batch Insurer" });
      expect(byId.get(lapsed)).toEqual({ standing: "LAPSED", insurerName: "Batch Expired" });
      expect(byId.get(none)).toEqual({ standing: "NONE" });

      // And every row on the board carries one, so the screen never has a hole to fill in later.
      for (const entry of board.entries) {
        expect(entry.coverage).toBeDefined();
        expect(["COVERED", "LAPSED", "NONE"]).toContain(entry.coverage.standing);
      }
    });
  });

  describe("the badge uses the clinic's day, not UTC", () => {
    test("a policy ending today is still covered", async () => {
      // The edge the timezone reasoning is about: a policy ending on the queue's own date is live
      // for the whole of that date. Compared against QueueQuery.date -- the clinic-local day the
      // rest of the board is already built on -- so the badge cannot disagree with its own row.
      const patientId = await queuedPatient("ينتهي اليوم");
      await givePolicy(patientId, "LastDay Co", "2026-01-01", DATE);

      expect(await badgeFor(patientId)).toEqual({
        standing: "COVERED",
        insurerName: "LastDay Co",
      });
    });

    test("a policy that ended yesterday is lapsed", async () => {
      const patientId = await queuedPatient("انتهى أمس");
      await givePolicy(patientId, "Yesterday Co", "2026-01-01", "2026-09-01");

      expect(await badgeFor(patientId)).toEqual({
        standing: "LAPSED",
        insurerName: "Yesterday Co",
      });
    });
  });
});
