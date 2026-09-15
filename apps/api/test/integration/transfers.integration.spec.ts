import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Module, ValidationPipe } from "@nestjs/common";
import { APP_INTERCEPTOR, NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { ActorContextInterceptor } from "../../src/common/actor-context.interceptor.ts";
import type { CallerContext } from "../../src/modules/appointments/appointments.service.ts";
import { issueAccessToken } from "../../src/modules/auth/jwt.ts";
import { completeConsultation } from "../../src/modules/queue/queue.service.ts";
import { TransfersController } from "../../src/modules/transfers/transfers.controller.ts";
import { prisma } from "../../src/prisma/client.ts";
import { injected } from "../../src/prisma/injected.ts";
import { withTenant } from "../../src/prisma/with-tenant.ts";
import { actorFor, createTestUser, seedClinic, teardownClinic, type ClinicFixture } from "./fixtures.ts";

/**
 * Patient transfers over HTTP — the three things the founder asked to see **proven**, not
 * implemented.
 *
 *   1. a pending request is visible from BOTH doctors' screens and from reception;
 *   2. a rejection reaches reception visibly, as a notification, not just a changed status;
 *   3. the request closes when the appointment ends while it is still open (D24's LAPSED).
 *
 * The expiry half of (2) — access actually being lost — lives in
 * `transfer-access-expiry.integration.spec.ts`, at the endpoint that returns clinical content.
 */
@Module({
  controllers: [TransfersController],
  providers: [{ provide: APP_INTERCEPTOR, useClass: ActorContextInterceptor }],
})
class TransfersTestModule {}

describe("patient transfers over HTTP", () => {
  let app: NestExpressApplication;
  let baseUrl: string;
  let clinic: ClinicFixture;
  let caller: CallerContext;

  let toDoctorId: string;
  let toMembershipId: string;
  let toUserId: string;

  let fromDoctorToken: string;
  let toDoctorToken: string;
  let receptionToken: string;

  const NOW = new Date("2026-09-01T09:00:00Z");

  const api = async (
    method: string,
    path: string,
    token: string,
    body?: unknown,
  ): Promise<{ status: number; json: Record<string, unknown> }> => {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return { status: response.status, json: text.length === 0 ? {} : (JSON.parse(text) as Record<string, unknown>) };
  };

  /**
   * Each test gets its own slot. `no_double_booking` is a real EXCLUDE constraint (D4), so two
   * appointments for one doctor at one instant are refused by the database -- which is the
   * constraint working, and is why every test here needs a distinct time rather than a shared one.
   */
  let slotCursor = 0;

  const openAppointment = async (): Promise<string> => {
    const id = randomUUID();
    slotCursor += 1;
    const start = new Date(NOW.getTime() + slotCursor * 60 * 60_000);
    await withTenant(clinic.tenantId, actorFor(clinic.userId), (tx) =>
      tx.appointment.create({
        data: injected({
          id,
          patientId: clinic.patientId,
          doctorId: clinic.doctorId,
          serviceId: clinic.serviceId,
          scheduledStart: start,
          scheduledEnd: new Date(start.getTime() + 30 * 60_000),
          status: "IN_CONSULTATION",
          source: "RECEPTION",
          arrivedAt: start,
          waitingStartedAt: start,
          consultationStartedAt: start,
          createdBy: clinic.userId,
          updatedBy: clinic.userId,
        }),
      }),
    );
    return id;
  };

  const clearTransfers = async (): Promise<void> => {
    await withTenant(clinic.tenantId, actorFor(clinic.userId), (tx) =>
      tx.patientTransfer.updateMany({
        where: { status: "PENDING" },
        data: { status: "LAPSED", decidedAt: NOW },
      }),
    );
  };

  beforeAll(async () => {
    clinic = await seedClinic();
    caller = {
      tenantId: clinic.tenantId,
      actor: actorFor(clinic.userId),
      role: "RECEPTIONIST",
      membershipId: clinic.membershipId,
    };
    toUserId = await createTestUser();

    await withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) => {
      toMembershipId = randomUUID();
      await tx.membership.create({
        data: injected({ id: toMembershipId, userId: toUserId, role: "DOCTOR", status: "ACTIVE" }),
      });
      toDoctorId = randomUUID();
      await tx.doctor.create({
        data: injected({
          id: toDoctorId,
          membershipId: toMembershipId,
          specialty: "Cardiology",
          licenseNumber: `LIC-${toDoctorId.replace(/-/g, "").slice(0, 8)}`,
          title: "Dr.",
        }),
      });
    });

    fromDoctorToken = await issueAccessToken({
      sub: clinic.userId,
      membershipId: clinic.membershipId,
      tenantId: clinic.tenantId,
      role: "DOCTOR",
    });
    toDoctorToken = await issueAccessToken({
      sub: toUserId,
      membershipId: toMembershipId,
      tenantId: clinic.tenantId,
      role: "DOCTOR",
    });
    // A REAL membership, not a fabricated uuid. `patient_transfers.initiated_by_membership_id` is
    // a foreign key, so a token carrying an invented membership fails at the database -- which is
    // the constraint working, and is worth leaving discoverable rather than papering over.
    // Memberships are unique per (user, tenant), so reception is a third human.
    const receptionUserId = await createTestUser();
    let receptionMembershipId = "";
    await withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) => {
      receptionMembershipId = randomUUID();
      await tx.membership.create({
        data: injected({
          id: receptionMembershipId,
          userId: receptionUserId,
          role: "RECEPTIONIST",
          status: "ACTIVE",
        }),
      });
    });
    receptionToken = await issueAccessToken({
      sub: receptionUserId,
      membershipId: receptionMembershipId,
      tenantId: clinic.tenantId,
      role: "RECEPTIONIST",
    });

    app = await NestFactory.create<NestExpressApplication>(TransfersTestModule, { logger: false });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    await app.listen(0, "127.0.0.1");
    baseUrl = `http://127.0.0.1:${((app.getHttpServer() as Server).address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    if (app !== undefined) await app.close();
    await teardownClinic(clinic);
    await prisma.$disconnect();
  });

  beforeEach(clearTransfers);

  /** Proof 1. The founder: "reception initiated it; they need to see it sitting there unanswered." */
  describe("a pending request is visible from all three surfaces", () => {
    test("reception, the original doctor, and the receiving doctor all see the same request", async () => {
      const appointmentId = await openAppointment();
      const created = await api("POST", "/transfers", receptionToken, { appointmentId, toDoctorId });
      expect(created.status).toBe(201);
      const transferId = created.json["id"];

      const seenBy = async (token: string): Promise<unknown[]> =>
        ((await api("GET", "/transfers", token)).json["transfers"] as unknown[]) ?? [];

      const [reception, fromDoctor, toDoctor] = await Promise.all([
        seenBy(receptionToken),
        seenBy(fromDoctorToken),
        seenBy(toDoctorToken),
      ]);

      for (const list of [reception, fromDoctor, toDoctor]) {
        expect(list).toHaveLength(1);
        expect((list[0] as { id: string }).id).toBe(transferId);
        expect((list[0] as { status: string }).status).toBe("PENDING");
      }
    });

    test("it carries when it was requested, so a screen can show how long it has sat", async () => {
      // No timeout was built -- reception can walk over -- which only works if the wait is visible.
      const appointmentId = await openAppointment();
      await api("POST", "/transfers", receptionToken, { appointmentId, toDoctorId });

      const list = (await api("GET", "/transfers", receptionToken)).json["transfers"] as { requestedAt: string }[];
      expect(Date.parse(list[0]?.requestedAt ?? "")).not.toBeNaN();
    });

    test("a doctor who is party to nothing sees nothing", async () => {
      // Non-vacuity for the assertions above: they would all pass against an endpoint that returned
      // every row to everybody, which is exactly the bug this project keeps finding.
      const appointmentId = await openAppointment();
      await api("POST", "/transfers", receptionToken, { appointmentId, toDoctorId });

      const strangerUserId = await createTestUser();
      let strangerMembershipId = "";
      await withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) => {
        strangerMembershipId = randomUUID();
        await tx.membership.create({
          data: injected({ id: strangerMembershipId, userId: strangerUserId, role: "DOCTOR", status: "ACTIVE" }),
        });
        await tx.doctor.create({
          data: injected({
            id: randomUUID(),
            membershipId: strangerMembershipId,
            specialty: "Dermatology",
            licenseNumber: `LIC-${strangerMembershipId.replace(/-/g, "").slice(0, 8)}`,
            title: "Dr.",
          }),
        });
      });
      const strangerToken = await issueAccessToken({
        sub: strangerUserId,
        membershipId: strangerMembershipId,
        tenantId: clinic.tenantId,
        role: "DOCTOR",
      });

      const list = (await api("GET", "/transfers", strangerToken)).json["transfers"] as unknown[];
      expect(list).toHaveLength(0);
    });
  });

  /**
   * **The owner holds no transfer capability — ruled 2026-09-06.**
   *
   * A transfer is a clinical hand-off between doctors, not a scheduling act. Before this it was
   * guarded by `appointments.write`, which the owner holds along with reception, booking and the
   * queue read — so there was no way to express "the owner is not part of this" without splitting
   * the capability, which is `PHASE-3.md` Q25 coming due.
   *
   * Asserted at the guard on all four routes, because the point of the split is that the server
   * refuses rather than that a screen omits a button.
   */
  describe("an owner is not part of a clinical hand-off", () => {
    test("all four transfer routes refuse an owner token", async () => {
      const ownerToken = await issueAccessToken({
        sub: clinic.userId,
        membershipId: clinic.membershipId,
        tenantId: clinic.tenantId,
        role: "OWNER",
      });

      const calls = [
        await api("GET", "/transfers", ownerToken),
        await api("POST", "/transfers", ownerToken, {
          appointmentId: "00000000-0000-7000-8000-00000000dead",
          toDoctorId: "00000000-0000-7000-8000-00000000beef",
          reason: "second opinion",
        }),
        await api("PATCH", "/transfers/00000000-0000-7000-8000-00000000dead/accept", ownerToken, {}),
        await api("PATCH", "/transfers/00000000-0000-7000-8000-00000000dead/reject", ownerToken, {
          decisionNote: "no",
        }),
      ];

      // 403 from the guard, before any handler runs -- not 404 from a missing row, which would
      // pass for the wrong reason and keep passing if the capability came back.
      for (const call of calls) expect(call.status).toBe(403);
    });
  });

  /** Proof 3. "A rejection that silently reverts is how a patient gets forgotten in a waiting room." */
  describe("a rejection reaches reception visibly", () => {
    test("rejecting without a reason is refused", async () => {
      const appointmentId = await openAppointment();
      const created = await api("POST", "/transfers", receptionToken, { appointmentId, toDoctorId });

      const rejected = await api("PATCH", `/transfers/${created.json["id"] as string}/reject`, toDoctorToken, {});
      expect(rejected.status).toBe(422);
      expect(rejected.json["code"]).toBe("REASON_REQUIRED");
    });

    test("a rejection writes a notification carrying the reason", async () => {
      const appointmentId = await openAppointment();
      const created = await api("POST", "/transfers", receptionToken, { appointmentId, toDoctorId });
      const transferId = created.json["id"] as string;

      const rejected = await api("PATCH", `/transfers/${transferId}/reject`, toDoctorToken, {
        decisionNote: "Fully booked until Thursday.",
      });
      expect(rejected.status).toBe(200);
      expect(rejected.json["status"]).toBe("REJECTED");

      // The status changing is not the requirement -- reception SEEING it is.
      const notifications = await withTenant(clinic.tenantId, actorFor(clinic.userId), (tx) =>
        tx.notification.findMany({ where: { kind: "TRANSFER_REJECTED" } }),
      );
      expect(notifications).toHaveLength(1);
      expect(JSON.stringify(notifications[0]?.payload)).toContain("Fully booked until Thursday.");
    });

    test("only the receiving doctor may decide, and everyone else gets 404", async () => {
      const appointmentId = await openAppointment();
      const created = await api("POST", "/transfers", receptionToken, { appointmentId, toDoctorId });
      const transferId = created.json["id"] as string;

      for (const token of [receptionToken, fromDoctorToken]) {
        const attempt = await api("PATCH", `/transfers/${transferId}/accept`, token, {});
        expect(attempt.status).toBe(404);
      }
    });

    test("two decisions race and exactly one wins", async () => {
      const appointmentId = await openAppointment();
      const created = await api("POST", "/transfers", receptionToken, { appointmentId, toDoctorId });
      const transferId = created.json["id"] as string;

      const [first, second] = await Promise.all([
        api("PATCH", `/transfers/${transferId}/accept`, toDoctorToken, {}),
        api("PATCH", `/transfers/${transferId}/reject`, toDoctorToken, { decisionNote: "On second thoughts." }),
      ]);

      const statuses = [first.status, second.status].sort();
      expect(statuses).toEqual([200, 409]);
    });
  });

  /** D24's fourth terminal state: the patient left, and a request is still waiting for an answer. */
  describe("an appointment that ends closes the open request", () => {
    test("completing the consultation lapses it and notifies", async () => {
      const appointmentId = await openAppointment();
      await api("POST", "/transfers", receptionToken, { appointmentId, toDoctorId });

      const done = await completeConsultation(caller, {
        appointmentId,
        expectedStatus: "IN_CONSULTATION",
        now: NOW,
      });
      expect(done.ok).toBe(true);

      const rows = await withTenant(clinic.tenantId, actorFor(clinic.userId), (tx) =>
        tx.patientTransfer.findMany({ where: { appointmentId } }),
      );
      expect(rows[0]?.status).toBe("LAPSED");

      const notifications = await withTenant(clinic.tenantId, actorFor(clinic.userId), (tx) =>
        tx.notification.findMany({ where: { kind: "TRANSFER_LAPSED", appointmentId } }),
      );
      expect(notifications).toHaveLength(1);
    });

    test("a lapsed request can no longer be accepted", async () => {
      const appointmentId = await openAppointment();
      const created = await api("POST", "/transfers", receptionToken, { appointmentId, toDoctorId });
      const transferId = created.json["id"] as string;

      await completeConsultation(caller, { appointmentId, expectedStatus: "IN_CONSULTATION", now: NOW });

      const attempt = await api("PATCH", `/transfers/${transferId}/accept`, toDoctorToken, {});
      expect(attempt.status).toBe(409);
      // One code for every settled request since 2026-09-07; `params.status` is what says the
      // appointment ended rather than a person having answered. Asserting the code alone would
      // pass against an implementation that had lost that distinction.
      expect(attempt.json["code"]).toBe("ALREADY_DECIDED");
      expect(attempt.json["params"]).toMatchObject({ status: "LAPSED" });
    });
  });

  /**
   * The caller-identity hole, found 2026-09-02.
   *
   * `requestTransfer` validated five things — the appointment exists, the receiving doctor exists,
   * it is not the doctor the patient is already with, no request is already open, and the DTO
   * refuses a `fromDoctorId` — and never asked **who was calling**. `appointments.write` is
   * `DOCTOR: FULL` (`common/permissions.ts`), so the guard let any doctor in, and the from-doctor
   * was read off the appointment rather than checked against the caller.
   *
   * The consequence is not merely a mis-attributed request. The receiving doctor is the one who
   * *decides*, so a doctor could raise a transfer of a colleague's patient **to themselves** and
   * then accept it — `hasActiveTransferGrant` would hand them thirty days of clinical read on a
   * patient they had never been involved with, correctly audited as a legitimate grant. Self-service
   * access to a colleague's patient, through the one endpoint built as a deliberate exception to the
   * doctor-only rule.
   *
   * This is the same defect class as the day/week/queue readers fixed on 2026-09-01, and the reason
   * `common/doctor-scope.ts` exists: *the guard permits the request; the query has to scope it.*
   */
  describe("a doctor may only raise a transfer for their own patient", () => {
    test("a doctor cannot raise one on a colleague's appointment — to themselves or anyone", async () => {
      const appointmentId = await openAppointment();

      // The appointment belongs to `clinic.doctorId`. This caller is a different doctor entirely,
      // naming themselves as the destination: the grab, in one request.
      const grab = await api("POST", "/transfers", toDoctorToken, { appointmentId, toDoctorId });
      expect(grab.status).toBe(404);

      // And nothing was written. A refusal that still creates the row would pass the assertion above
      // while leaving the patient's one open-request slot taken.
      const rows = await withTenant(clinic.tenantId, actorFor(clinic.userId), (tx) =>
        tx.patientTransfer.findMany({ where: { appointmentId } }),
      );
      expect(rows).toHaveLength(0);
    });

    test("the refusal is indistinguishable from an appointment that does not exist", async () => {
      // PHASE-3.md's Definition of Done, and CLAUDE.md's cross-tenant rule: 404, not 403. A 403 here
      // would confirm the appointment exists and tell a doctor which of their colleagues' patients
      // are in the building.
      const appointmentId = await openAppointment();

      const colleagues = await api("POST", "/transfers", toDoctorToken, { appointmentId, toDoctorId });
      const nonexistent = await api("POST", "/transfers", toDoctorToken, {
        appointmentId: randomUUID(),
        toDoctorId,
      });

      expect(colleagues.status).toBe(nonexistent.status);
      expect(colleagues.json["message"]).toBe(nonexistent.json["message"]);
    });

    test("the appointment's own doctor may still raise one", async () => {
      // Non-vacuity. Every assertion above would also pass against an endpoint that refused every
      // doctor, which would break the founder's case for the feature: a doctor mid-consultation
      // decides the patient is not theirs.
      const appointmentId = await openAppointment();

      const own = await api("POST", "/transfers", fromDoctorToken, { appointmentId, toDoctorId });
      expect(own.status).toBe(201);
      expect(own.json["fromDoctorId"]).toBe(clinic.doctorId);
    });

    test("reception may still raise one for any doctor's patient", async () => {
      // The other half of non-vacuity: reception is pinned to nobody and raises most requests.
      const appointmentId = await openAppointment();

      const desk = await api("POST", "/transfers", receptionToken, { appointmentId, toDoctorId });
      expect(desk.status).toBe(201);
    });
  });

  describe("one open request per patient", () => {
    test("a second request while one is open is refused", async () => {
      const appointmentId = await openAppointment();
      await api("POST", "/transfers", receptionToken, { appointmentId, toDoctorId });

      const second = await api("POST", "/transfers", receptionToken, { appointmentId, toDoctorId });
      expect(second.status).toBe(409);
      expect(second.json["code"]).toBe("ALREADY_OPEN");
    });

    test("transferring to the doctor the patient is already with is refused", async () => {
      const appointmentId = await openAppointment();
      const same = await api("POST", "/transfers", receptionToken, {
        appointmentId,
        toDoctorId: clinic.doctorId,
      });
      expect(same.status).toBe(422);
      expect(same.json["code"]).toBe("SAME_DOCTOR");
    });
  });
});
