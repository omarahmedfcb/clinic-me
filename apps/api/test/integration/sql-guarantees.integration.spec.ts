import { randomUUID } from "node:crypto";
import { prisma } from "../../src/prisma/client.ts";
import { injected, injectedIdOnly } from "../../src/prisma/injected.ts";
import { withTenant } from "../../src/prisma/with-tenant.ts";
import { actorFor, type ClinicFixture, seedClinic, teardownClinic } from "./fixtures.ts";

/**
 * Ports the Checkpoint 2 SQL guarantees -- verified by hand via psql across two sessions -- into
 * the repo: the no_double_booking exclusion constraint, the four append-only triggers, and the
 * Payment.remainingMinor generated column. These are Postgres-level guarantees, so most
 * assertions here use $executeRawUnsafe / typed Prisma calls that reach the database directly,
 * not the tenant-scoping extension's own JS-level guards (those are covered by
 * with-tenant.integration.spec.ts and the unit specs) -- the point is to prove the database
 * itself still enforces these even if application code bypassed the extension somehow.
 */
describe("SQL guarantees", () => {
  let fixture: ClinicFixture;

  beforeAll(async () => {
    fixture = await seedClinic();
  });

  afterAll(async () => {
    await teardownClinic(fixture);
    await prisma.$disconnect();
  });

  describe("no_double_booking exclusion constraint", () => {
    const start = new Date("2027-01-10T10:00:00Z");
    const end = new Date("2027-01-10T10:30:00Z");
    const overlapStart = new Date("2027-01-10T10:15:00Z");
    const overlapEnd = new Date("2027-01-10T10:45:00Z");

    afterEach(async () => {
      await withTenant(fixture.tenantId, actorFor(fixture.userId), async (tx) => tx.appointment.deleteMany());
    });

    test("blocks an overlapping appointment for the same doctor", async () => {
      await withTenant(fixture.tenantId, actorFor(fixture.userId), async (tx) =>
        tx.appointment.create({
          data: injected({
            patientId: fixture.patientId,
            doctorId: fixture.doctorId,
            serviceId: fixture.serviceId,
            scheduledStart: start,
            scheduledEnd: end,
            status: "BOOKED",
            source: "RECEPTION",
            createdBy: fixture.userId,
            updatedBy: fixture.userId,
          }),
        }),
      );

      await expect(
        withTenant(fixture.tenantId, actorFor(fixture.userId), async (tx) =>
          tx.appointment.create({
            data: injected({
              patientId: fixture.patientId,
              doctorId: fixture.doctorId,
              serviceId: fixture.serviceId,
              scheduledStart: overlapStart,
              scheduledEnd: overlapEnd,
              status: "BOOKED",
              source: "RECEPTION",
              createdBy: fixture.userId,
              updatedBy: fixture.userId,
            }),
          }),
        ),
      ).rejects.toThrow();
    });

    test("allows the same overlap with allow_overlap=true and an authorisation", async () => {
      await withTenant(fixture.tenantId, actorFor(fixture.userId), async (tx) =>
        tx.appointment.create({
          data: injected({
            patientId: fixture.patientId,
            doctorId: fixture.doctorId,
            serviceId: fixture.serviceId,
            scheduledStart: start,
            scheduledEnd: end,
            status: "BOOKED",
            source: "RECEPTION",
            createdBy: fixture.userId,
            updatedBy: fixture.userId,
          }),
        }),
      );

      const authorised = await withTenant(fixture.tenantId, actorFor(fixture.userId), async (tx) =>
        tx.appointment.create({
          data: injected({
            patientId: fixture.patientId,
            doctorId: fixture.doctorId,
            serviceId: fixture.serviceId,
            scheduledStart: overlapStart,
            scheduledEnd: overlapEnd,
            status: "BOOKED",
            source: "RECEPTION",
            createdBy: fixture.userId,
            updatedBy: fixture.userId,
            allowOverlap: true,
            overlapAuthorisedByUserId: fixture.userId,
            overlapReason: "doctor authorised double-booking for urgent case",
          }),
        }),
      );
      expect(authorised.id).toBeTruthy();
    });

    test("allows an overlapping CANCELLED appointment (status is exempt)", async () => {
      await withTenant(fixture.tenantId, actorFor(fixture.userId), async (tx) =>
        tx.appointment.create({
          data: injected({
            patientId: fixture.patientId,
            doctorId: fixture.doctorId,
            serviceId: fixture.serviceId,
            scheduledStart: start,
            scheduledEnd: end,
            status: "BOOKED",
            source: "RECEPTION",
            createdBy: fixture.userId,
            updatedBy: fixture.userId,
          }),
        }),
      );

      const cancelled = await withTenant(fixture.tenantId, actorFor(fixture.userId), async (tx) =>
        tx.appointment.create({
          data: injected({
            patientId: fixture.patientId,
            doctorId: fixture.doctorId,
            serviceId: fixture.serviceId,
            scheduledStart: overlapStart,
            scheduledEnd: overlapEnd,
            status: "CANCELLED",
            source: "RECEPTION",
            createdBy: fixture.userId,
            updatedBy: fixture.userId,
          }),
        }),
      );
      expect(cancelled.id).toBeTruthy();
    });
  });

  describe("append-only triggers", () => {
    test("audit_logs rejects UPDATE and DELETE", async () => {
      // Wrapped in withTenant() since D17 put RLS on audit_logs: the insert has to happen in a
      // session bound to the tenant it stamps the row with, or WITH CHECK rejects it before the
      // append-only trigger this test is actually about ever comes into play. The two guarantees
      // are orthogonal and both apply -- RLS governs which rows a session may touch, the
      // append-only trigger governs which operations exist at all.
      const row = await withTenant(fixture.tenantId, actorFor(fixture.userId), async (tx) =>
        tx.auditLog.create({
          // injectedIdOnly(), not injected(): audit_logs is TENANT_POLICY "nullable"
          // (tenant-scoped-models.ts), so the extension supplies the id but never the tenantId --
          // a null tenant is a meaningful value on this table (D17/D18) and has to be chosen, not
          // guessed. Which is why the row below sets it explicitly.
          data: injectedIdOnly({
            tenantId: fixture.tenantId,
            actorUserId: fixture.userId,
            actorRole: "OWNER",
            action: "CREATE",
            entityType: "patient",
            entityId: fixture.patientId,
            ipAddress: "127.0.0.1",
            userAgent: "jest",
          }),
        }),
      );

      // Also bound: an unbound session would not see the row at all under the new policy, and
      // Prisma would report "record not found" instead of the append-only rejection this asserts.
      // The distinction matters -- a test that accepted either would stop proving the trigger.
      await expect(
        withTenant(fixture.tenantId, actorFor(fixture.userId), async (tx) =>
          tx.auditLog.update({ where: { id: row.id }, data: { ipAddress: "10.0.0.1" } }),
        ),
      ).rejects.toThrow("append-only");
      await expect(
        withTenant(fixture.tenantId, actorFor(fixture.userId), async (tx) =>
          tx.auditLog.delete({ where: { id: row.id } }),
        ),
      ).rejects.toThrow("append-only");
    });

    test("appointment_events rejects UPDATE and DELETE", async () => {
      const appointment = await withTenant(fixture.tenantId, actorFor(fixture.userId), async (tx) =>
        tx.appointment.create({
          data: injected({
            patientId: fixture.patientId,
            doctorId: fixture.doctorId,
            serviceId: fixture.serviceId,
            scheduledStart: new Date("2027-01-11T09:00:00Z"),
            scheduledEnd: new Date("2027-01-11T09:30:00Z"),
            status: "BOOKED",
            source: "RECEPTION",
            createdBy: fixture.userId,
            updatedBy: fixture.userId,
          }),
        }),
      );

      const event = await withTenant(fixture.tenantId, actorFor(fixture.userId), async (tx) =>
        tx.appointmentEvent.create({
          data: injected({
            appointmentId: appointment.id,
            eventType: "CREATED",
            actorUserId: fixture.userId,
          }),
        }),
      );

      await expect(
        withTenant(fixture.tenantId, actorFor(fixture.userId), async (tx) =>
          tx.appointmentEvent.update({ where: { id: event.id }, data: { reason: "changed" } }),
        ),
      ).rejects.toThrow("append-only");
      await expect(
        withTenant(fixture.tenantId, actorFor(fixture.userId), async (tx) => tx.appointmentEvent.delete({ where: { id: event.id } })),
      ).rejects.toThrow("append-only");
    });

    test("visit_revisions rejects UPDATE and DELETE", async () => {
      const appointment = await withTenant(fixture.tenantId, actorFor(fixture.userId), async (tx) =>
        tx.appointment.create({
          data: injected({
            patientId: fixture.patientId,
            doctorId: fixture.doctorId,
            serviceId: fixture.serviceId,
            scheduledStart: new Date("2027-01-12T09:00:00Z"),
            scheduledEnd: new Date("2027-01-12T09:30:00Z"),
            status: "BOOKED",
            source: "RECEPTION",
            createdBy: fixture.userId,
            updatedBy: fixture.userId,
          }),
        }),
      );
      const visit = await withTenant(fixture.tenantId, actorFor(fixture.userId), async (tx) =>
        tx.visit.create({
          data: injected({
            patientId: fixture.patientId,
            doctorId: fixture.doctorId,
            appointmentId: appointment.id,
            status: "DRAFT",
            createdBy: fixture.userId,
          }),
        }),
      );
      const revision = await withTenant(fixture.tenantId, actorFor(fixture.userId), async (tx) =>
        tx.visitRevision.create({
          data: injected({
            visitId: visit.id,
            changedFields: { diagnosis: "old -> new" },
            previousValues: { diagnosis: "old" },
            actorUserId: fixture.userId,
            reason: "correction",
          }),
        }),
      );

      await expect(
        withTenant(fixture.tenantId, actorFor(fixture.userId), async (tx) =>
          tx.visitRevision.update({ where: { id: revision.id }, data: { reason: "edited" } }),
        ),
      ).rejects.toThrow("append-only");
      await expect(
        withTenant(fixture.tenantId, actorFor(fixture.userId), async (tx) => tx.visitRevision.delete({ where: { id: revision.id } })),
      ).rejects.toThrow("append-only");
    });

    test("payment_adjustments rejects UPDATE and DELETE", async () => {
      const payment = await withTenant(fixture.tenantId, actorFor(fixture.userId), async (tx) =>
        tx.payment.create({
          data: injected({
            patientId: fixture.patientId,
            amountMinor: 0,
            method: "CASH",
            status: "UNPAID",
          }),
        }),
      );
      const adjustment = await withTenant(fixture.tenantId, actorFor(fixture.userId), async (tx) =>
        tx.paymentAdjustment.create({
          data: injected({
            paymentId: payment.id,
            adjustmentType: "DISCOUNT_APPLIED",
            amountMinor: -1000,
            reason: "loyalty discount",
            actorUserId: fixture.userId,
            previousStatus: "UNPAID",
            newStatus: "PARTIAL",
          }),
        }),
      );

      await expect(
        withTenant(fixture.tenantId, actorFor(fixture.userId), async (tx) =>
          tx.paymentAdjustment.update({ where: { id: adjustment.id }, data: { reason: "edited" } }),
        ),
      ).rejects.toThrow("append-only");
      await expect(
        withTenant(fixture.tenantId, actorFor(fixture.userId), async (tx) => tx.paymentAdjustment.delete({ where: { id: adjustment.id } })),
      ).rejects.toThrow("append-only");
    });
  });

  describe("the payment balance, after Phase 5 PR 5 moved it", () => {
    /**
     * This replaces a test of `payments.remaining_minor`, a GENERATED column that no longer
     * exists. The concept did not disappear -- it moved: a balance is now a sum across payment
     * rows, which no generated column can express, and `visit_charge_balances` computes it.
     * D7 as amended 2026-09-03 is what permits a view in a rule that said "generated column".
     *
     * What is asserted here is the migration itself: the column is gone, and the receipt keeps the
     * three things the founder required it to keep -- amount, date and method.
     */
    test("the generated column is gone and the receipt kept its amount, date and method", async () => {
      const columns = await withTenant(fixture.tenantId, actorFor(fixture.userId), async (tx) =>
        tx.$queryRaw<{ column_name: string }[]>`
          SELECT column_name FROM information_schema.columns WHERE table_name = 'payments'`,
      );
      const names = columns.map((column) => column.column_name);
      for (const gone of ["remaining_minor", "service_price_minor", "amount_due_minor", "discount_amount_minor"]) {
        expect({ gone, present: names.includes(gone) }).toEqual({ gone, present: false });
      }
      for (const kept of ["amount_minor", "receipt_date", "method", "receipt_number"]) {
        expect({ kept, present: names.includes(kept) }).toEqual({ kept, present: true });
      }
    });
  });

  /**
   * `services.dto.ts` claimed its bounds mirrored database CHECKs. Read against `pg_constraint` on
   * 2026-09-03, only `buffer_minutes` had one — `duration_minutes` and `price_minor` had none, so
   * for two of three fields a DTO was the only thing refusing a bad value while a comment said the
   * database was.
   *
   * These tests write past the DTO deliberately, because that is the whole point: the seed, direct
   * SQL and any future bulk import never see it.
   */
  describe("services value constraints", () => {
    test("rejects a negative price, which no screen would ever show as wrong", async () => {
      await expect(
        withTenant(fixture.tenantId, actorFor(fixture.userId), async (tx) =>
          tx.service.update({ where: { id: fixture.serviceId }, data: { priceMinor: -1 } }),
        ),
      ).rejects.toThrow(/services_price_minor_non_negative/);
    });

    test("rejects a zero-length and an absurdly long duration", async () => {
      for (const durationMinutes of [0, 481]) {
        await expect(
          withTenant(fixture.tenantId, actorFor(fixture.userId), async (tx) =>
            tx.service.update({ where: { id: fixture.serviceId }, data: { durationMinutes } }),
          ),
        ).rejects.toThrow(/services_duration_minutes_sane/);
      }
    });

    test("still accepts the values the DTO allows, so the constraint is a backstop and not a second opinion", async () => {
      const updated = await withTenant(fixture.tenantId, actorFor(fixture.userId), async (tx) =>
        tx.service.update({
          where: { id: fixture.serviceId },
          data: { priceMinor: 0, durationMinutes: 480 },
        }),
      );
      expect(updated.priceMinor).toBe(0);
      expect(updated.durationMinutes).toBe(480);
    });
  });

  /**
   * One COMPLETED visit per appointment — `PHASE-4.md` Q2 and Q15, `PHASE-4-PLAN.md` PR 1.
   *
   * **Here rather than in a service spec, deliberately.** The Definition of Done says this is
   * "proven by attempting a second and being refused by the database, not by the service", and the
   * distinction is the entire value of the constraint: a service-layer check passes unchanged on a
   * machine where the migration was never applied. These calls go through the tenant extension but
   * nothing else — there is no visit write path yet to route around, and when there is (PR 2), this
   * file still asserts the floor beneath it.
   *
   * The pair of tests matters more than either alone. A plain `@@unique([appointmentId])` would
   * satisfy the first and fail the second, and it is the obvious wrong implementation — which is
   * why "several drafts are allowed" is asserted as a guarantee rather than assumed.
   */
  describe("one COMPLETED visit per appointment", () => {
    async function appointmentFor(hour: string): Promise<string> {
      const appointment = await withTenant(fixture.tenantId, actorFor(fixture.userId), async (tx) =>
        tx.appointment.create({
          data: injected({
            patientId: fixture.patientId,
            doctorId: fixture.doctorId,
            serviceId: fixture.serviceId,
            scheduledStart: new Date(`2027-02-02T${hour}:00:00Z`),
            scheduledEnd: new Date(`2027-02-02T${hour}:30:00Z`),
            status: "BOOKED",
            source: "RECEPTION",
            createdBy: fixture.userId,
            updatedBy: fixture.userId,
          }),
        }),
      );
      return appointment.id;
    }

    async function createVisit(appointmentId: string, status: "DRAFT" | "COMPLETED"): Promise<string> {
      const visit = await withTenant(fixture.tenantId, actorFor(fixture.userId), async (tx) =>
        tx.visit.create({
          data: injected({
            patientId: fixture.patientId,
            doctorId: fixture.doctorId,
            appointmentId,
            status,
            createdBy: fixture.userId,
            ...(status === "COMPLETED" ? { completedAt: new Date() } : {}),
          }),
        }),
      );
      return visit.id;
    }

    /**
     * The duplicate insert goes through `$executeRawUnsafe`, not `tx.visit.create()`.
     *
     * Not for convenience: Prisma reports a partial unique index as
     * *"Unique constraint failed on the (not available)"* — it knows the write was refused and
     * cannot name what refused it, because `@@unique` has no `WHERE` and the index is invisible to
     * the client's model. Asserting on that message would prove only that *some* unique constraint
     * fired, which is exactly the weaker claim this test exists to avoid making.
     *
     * Raw SQL surfaces Postgres's own error, which names the index. That is also what this file
     * says it does and why: reach the database directly, so the guarantee is shown to hold
     * independently of anything the application layer believes.
     */
    test("a second COMPLETED visit is refused by Postgres, and by the named index", async () => {
      const appointmentId = await appointmentFor("09");
      await createVisit(appointmentId, "COMPLETED");

      await expect(
        withTenant(fixture.tenantId, actorFor(fixture.userId), async (tx) =>
          tx.$executeRawUnsafe(
            `INSERT INTO visits (id, tenant_id, patient_id, doctor_id, appointment_id, status, completed_at, created_by, created_at, updated_at)
             VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, 'COMPLETED'::"VisitStatus", now(), $6::uuid, now(), now())`,
            randomUUID(),
            fixture.tenantId,
            fixture.patientId,
            fixture.doctorId,
            appointmentId,
            fixture.userId,
          ),
        ),
      ).rejects.toThrow(/visits_one_completed_per_appointment/);
    });

    test("and the same refusal reaches application code through Prisma", async () => {
      // The pairing matters. The raw test proves *what* refuses; this proves the refusal is not
      // swallowed on the way back to the service that will have to handle it in PR 4. Prisma
      // cannot name a partial index, so P2002 is the most this half can honestly assert -- which
      // is why it is the second test and not the only one.
      const appointmentId = await appointmentFor("12");
      await createVisit(appointmentId, "COMPLETED");

      await expect(createVisit(appointmentId, "COMPLETED")).rejects.toMatchObject({ code: "P2002" });
    });

    test("several DRAFTs on one appointment are allowed, which is the half a plain unique breaks", async () => {
      // Q15: after a transfer the receiving doctor gets their own empty draft while the
      // originating doctor's draft still exists. Two drafts against one appointment is the
      // ordinary case, not an edge one.
      const appointmentId = await appointmentFor("10");
      const first = await createVisit(appointmentId, "DRAFT");
      const second = await createVisit(appointmentId, "DRAFT");
      const third = await createVisit(appointmentId, "DRAFT");

      expect(new Set([first, second, third]).size).toBe(3);
    });

    test("a draft may be completed while other drafts on the same appointment remain", async () => {
      // The two rules meeting: the index counts COMPLETED rows only, so finishing one draft does
      // not require the others to be gone first. This is the state PR 2 and PR 3 will produce.
      const appointmentId = await appointmentFor("11");
      const toFinish = await createVisit(appointmentId, "DRAFT");
      await createVisit(appointmentId, "DRAFT");

      const finished = await withTenant(fixture.tenantId, actorFor(fixture.userId), async (tx) =>
        tx.visit.update({
          where: { id: toFinish },
          data: { status: "COMPLETED", completedAt: new Date() },
        }),
      );
      expect(finished.status).toBe("COMPLETED");

      // And a second completion on that same appointment is still refused — the constraint holds
      // against an UPDATE, not only against an INSERT. This is the case PR 4 will actually hit:
      // completing a visit is an UPDATE of an existing draft, never an insert.
      const other = await createVisit(appointmentId, "DRAFT");
      await expect(
        withTenant(fixture.tenantId, actorFor(fixture.userId), async (tx) =>
          tx.visit.update({
            where: { id: other },
            data: { status: "COMPLETED", completedAt: new Date() },
          }),
        ),
      ).rejects.toMatchObject({ code: "P2002" });
    });
  });

  /**
   * One national ID per tenant — `SCHEMA-DECISIONS.md` D27, `PHASE-4-PLAN.md` PR 7a.
   *
   * At the database, because the race this loses at the service layer is real and ordinary: two
   * receptionists registering the same walk-in seconds apart both read, both find nothing, both
   * insert. A unique index has no such window.
   */
  describe("one national ID per tenant", () => {
    const NID = "29001010123456";

    async function createPatient(nationalId: string | null): Promise<string> {
      const id = randomUUID();
      await withTenant(fixture.tenantId, actorFor(fixture.userId), async (tx) => {
        await tx.patient.create({
          data: injected({
            id,
            fullNameAr: "مريض اختبار",
            phoneE164: `+2010${String(Date.now()).slice(-8)}`,
            nationalId,
            relationshipToContact: "SELF",
            status: "ACTIVE",
          }),
        });
      });
      return id;
    }

    test("a second patient with the same national ID is refused by Postgres", async () => {
      await createPatient(NID);
      await expect(createPatient(NID)).rejects.toMatchObject({ code: "P2002" });
    });

    test("several patients with no national ID are fine, which a plain UNIQUE would still allow", async () => {
      // Asserted anyway: the index is partial on purpose, and a later "tidy-up" that dropped the
      // WHERE clause would still pass the test above while breaking every child and every walk-in
      // without a card.
      const a = await createPatient(null);
      const b = await createPatient(null);
      const c = await createPatient(null);
      expect(new Set([a, b, c]).size).toBe(3);
    });
  });

  describe("visits.revision, the compare-and-set counter", () => {
    test("defaults to 0 so every row has a value to compare against", async () => {
      // Q7's mechanism needs a defined starting point on rows created before the write path
      // exists. Asserted because a nullable or absent default would make the first save of every
      // visit compare against undefined, which fails open rather than closed.
      const appointment = await withTenant(fixture.tenantId, actorFor(fixture.userId), async (tx) =>
        tx.appointment.create({
          data: injected({
            patientId: fixture.patientId,
            doctorId: fixture.doctorId,
            serviceId: fixture.serviceId,
            scheduledStart: new Date("2027-02-03T09:00:00Z"),
            scheduledEnd: new Date("2027-02-03T09:30:00Z"),
            status: "BOOKED",
            source: "RECEPTION",
            createdBy: fixture.userId,
            updatedBy: fixture.userId,
          }),
        }),
      );
      const visit = await withTenant(fixture.tenantId, actorFor(fixture.userId), async (tx) =>
        tx.visit.create({
          data: injected({
            patientId: fixture.patientId,
            doctorId: fixture.doctorId,
            appointmentId: appointment.id,
            status: "DRAFT",
            createdBy: fixture.userId,
          }),
        }),
      );

      expect(visit.revision).toBe(0);
    });
  });
});
