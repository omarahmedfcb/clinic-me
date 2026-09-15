import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Module, ValidationPipe } from "@nestjs/common";
import { APP_INTERCEPTOR, NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { ActorContextInterceptor } from "../../src/common/actor-context.interceptor.ts";
import {
  bookAppointment,
  findAvailableSlots,
  type CallerContext,
} from "../../src/modules/appointments/appointments.service.ts";
import { issueAccessToken } from "../../src/modules/auth/jwt.ts";
import { AppointmentsController } from "../../src/modules/appointments/appointments.controller.ts";
import { QueueController } from "../../src/modules/queue/queue.controller.ts";
import { prisma } from "../../src/prisma/client.ts";
import { injected } from "../../src/prisma/injected.ts";
import { withTenant } from "../../src/prisma/with-tenant.ts";
import { actorFor, seedClinic, teardownClinic, type ClinicFixture } from "./fixtures.ts";

/**
 * The queue over HTTP — `PHASE-3.md` checkpoint 4.
 *
 * Checkpoint 3 proved the service. This proves the **endpoints**: that the transitions are
 * reachable and refusable through HTTP, that a cross-tenant id is indistinguishable from one that
 * never existed, that the permission guard is real, and that Q2's compare-and-set survives two
 * clients racing through the controller rather than only through the service.
 *
 * Every guard here is asserted by **breaking what it guards** — the run that matters is the one
 * where the protection is absent and the test goes red, which is recorded in the commit message
 * rather than claimed here.
 */
@Module({
  // AppointmentsController is mounted alongside so the read/write split can be asserted
  // against one token: the queue reads and the booking writes are the two halves of it.
  controllers: [QueueController, AppointmentsController],
  providers: [{ provide: APP_INTERCEPTOR, useClass: ActorContextInterceptor }],
})
class QueueTestModule {}

describe("the queue over HTTP", () => {
  let app: NestExpressApplication;
  let baseUrl: string;
  let clinicA: ClinicFixture;
  let clinicB: ClinicFixture;
  let callerA: CallerContext;
  let callerB: CallerContext;

  let receptionToken: string;
  let doctorToken: string;
  let ownerToken: string;
  let agentToken: string;
  let tokenB: string;

  const DATE = "2026-09-01"; // A Tuesday, clear of any Egyptian DST transition.
  const NOW = new Date("2026-08-25T06:00:00Z");
  const NEVER_EXISTED = "00000000-0000-7000-8000-00000000dead";

  async function giveTuesdayHours(fixture: ClinicFixture): Promise<void> {
    await withTenant(fixture.tenantId, actorFor(fixture.userId), async (tx) => {
      await tx.scheduleTemplate.create({
        data: injected({
          doctorId: fixture.doctorId,
          weekday: 2,
          startTime: new Date(Date.UTC(1970, 0, 1, 9, 0, 0)),
          endTime: new Date(Date.UTC(1970, 0, 1, 18, 0, 0)),
          validFrom: new Date(Date.UTC(2026, 0, 1)),
          validTo: null,
        }),
      });
    });
  }

  /** Books one appointment in the given clinic and returns its id. */
  async function book(caller: CallerContext, fixture: ClinicFixture): Promise<string> {
    const availability = await findAvailableSlots(caller, {
      doctorId: fixture.doctorId,
      serviceId: fixture.serviceId,
      date: DATE,
      channel: "STAFF",
      now: NOW,
    });
    if (!availability.ok) throw new Error("availability failed");
    const slot = availability.slots[0];
    if (slot === undefined) throw new Error("no slot free — the day is full");

    const result = await bookAppointment(caller, {
      slotToken: slot.token,
      patientId: fixture.patientId,
      source: "RECEPTION",
      complaintSummary: null,
      bookingNotes: null,
      now: NOW,
    });
    if (!result.ok) throw new Error(`booking failed: ${result.code}`);
    return result.appointmentId;
  }

  async function patch(
    path: string,
    token: string,
    body: unknown,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const response = await fetch(`${baseUrl}${path}`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  }

  async function get(
    path: string,
    token: string,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const response = await fetch(`${baseUrl}${path}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  }

  beforeAll(async () => {
    clinicA = await seedClinic();
    clinicB = await seedClinic();
    callerA = { tenantId: clinicA.tenantId, actor: actorFor(clinicA.userId), role: "RECEPTIONIST", membershipId: clinicA.membershipId };
    callerB = { tenantId: clinicB.tenantId, actor: actorFor(clinicB.userId), role: "RECEPTIONIST", membershipId: clinicB.membershipId };
    await giveTuesdayHours(clinicA);
    await giveTuesdayHours(clinicB);

    app = await NestFactory.create<NestExpressApplication>(QueueTestModule, { logger: false });
    app.set("trust proxy", 1);
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();
    await app.listen(0, "127.0.0.1");
    baseUrl = `http://127.0.0.1:${((app.getHttpServer() as Server).address() as AddressInfo).port}`;

    receptionToken = await issueAccessToken({
      sub: clinicA.userId,
      membershipId: randomUUID(),
      tenantId: clinicA.tenantId,
      role: "RECEPTIONIST",
    });

    // Completing a visit is DOCTOR-only as of 2026-09-03 (Q13 revisited), and **starting one joined
    // it on 2026-09-09 (Q40)**. Reception keeps check-in, transfer and no-show.
    //
    // The membership is `clinicA.membershipId` and not a fresh id: both moves now go through
    // `moveOwn`, which resolves the caller's doctor row from their membership and compares it with
    // the appointment's. A token carrying a membership that does not exist is not a doctor at all,
    // and would fail these tests for the wrong reason.
    doctorToken = await issueAccessToken({
      sub: clinicA.userId,
      membershipId: clinicA.membershipId,
      tenantId: clinicA.tenantId,
      role: "DOCTOR",
    });

    // AI_AGENT holds NONE on every capability, deliberately — `permissions.ts`. It *used* to be the
    // only role that could prove PermissionGuard does anything, because all four human roles held
    // `appointments.write` in full (Q13). Since Q13 was revisited that is no longer true:
    // RECEPTIONIST now proves it on the complete route.
    ownerToken = await issueAccessToken({
      sub: clinicA.userId,
      membershipId: clinicA.membershipId,
      tenantId: clinicA.tenantId,
      role: "OWNER",
    });
    agentToken = await issueAccessToken({
      sub: clinicA.userId,
      membershipId: randomUUID(),
      tenantId: clinicA.tenantId,
      role: "AI_AGENT",
    });

    tokenB = await issueAccessToken({
      sub: clinicB.userId,
      membershipId: randomUUID(),
      tenantId: clinicB.tenantId,
      role: "RECEPTIONIST",
    });
  });

  afterAll(async () => {
    // Guarded: if beforeAll threw, an unguarded close() masks the real error with a TypeError.
    if (app !== undefined) await app.close();
    if (clinicA !== undefined) await teardownClinic(clinicA);
    if (clinicB !== undefined) await teardownClinic(clinicB);
    await prisma.$disconnect();
  });

  describe("the transitions are reachable through HTTP", () => {
    it("check-in, start, complete — each moves the row and reports the new status", async () => {
      const id = await book(callerA, clinicA);

      const checkedIn = await patch(`/queue/${id}/check-in`, receptionToken, {
        expectedStatus: "BOOKED",
      });
      expect(checkedIn.status).toBe(200);
      expect(checkedIn.body["status"]).toBe("WAITING");

      const started = await patch(`/queue/${id}/start`, doctorToken, {
        expectedStatus: "WAITING",
      });
      expect(started.status).toBe(200);
      expect(started.body["status"]).toBe("IN_CONSULTATION");

      const completed = await patch(`/queue/${id}/complete`, doctorToken, {
        expectedStatus: "IN_CONSULTATION",
      });
      expect(completed.status).toBe(200);
      expect(completed.body["status"]).toBe("COMPLETED");
    });

    it("an illegal transition is 409, not 400 — asking is well-formed, the row's state refuses", async () => {
      const id = await book(callerA, clinicA);
      await patch(`/queue/${id}/check-in`, receptionToken, { expectedStatus: "BOOKED" });
      await patch(`/queue/${id}/start`, doctorToken, { expectedStatus: "WAITING" });
      await patch(`/queue/${id}/complete`, doctorToken, { expectedStatus: "IN_CONSULTATION" });

      // COMPLETED is terminal (Q15): transition() refuses every event out of it.
      const again = await patch(`/queue/${id}/start`, doctorToken, {
        expectedStatus: "COMPLETED",
      });
      expect(again.status).toBe(409);
      expect(again.body["code"]).not.toBe("QUEUE_MOVED_ON");
    });

    it("the queue lists a checked-in patient, and drops them once completed", async () => {
      const id = await book(callerA, clinicA);
      await patch(`/queue/${id}/check-in`, receptionToken, { expectedStatus: "BOOKED" });

      const onQueue = await get(`/queue/today?date=${DATE}`, receptionToken);
      expect(onQueue.status).toBe(200);
      const listed = (onQueue.body["entries"] as { appointmentId: string }[]).map(
        (e) => e.appointmentId,
      );
      expect(listed).toContain(id);

      await patch(`/queue/${id}/start`, doctorToken, { expectedStatus: "WAITING" });
      await patch(`/queue/${id}/complete`, doctorToken, { expectedStatus: "IN_CONSULTATION" });

      const after = await get(`/queue/today?date=${DATE}`, receptionToken);
      const stillListed = (after.body["entries"] as { appointmentId: string }[]).map(
        (e) => e.appointmentId,
      );
      expect(stillListed).not.toContain(id);
    });

    it("the pending no-show list is reachable and is a read", async () => {
      const response = await get(`/no-shows/pending?date=${DATE}`, receptionToken);
      expect(response.status).toBe(200);
      expect(Array.isArray(response.body["candidates"])).toBe(true);
    });
  });

  describe("compare-and-set through the controller (Q2)", () => {
    it("a stale expectation is 409 and carries what actually happened", async () => {
      const id = await book(callerA, clinicA);
      await patch(`/queue/${id}/check-in`, receptionToken, { expectedStatus: "BOOKED" });

      // A second screen still showing BOOKED.
      const stale = await patch(`/queue/${id}/check-in`, receptionToken, {
        expectedStatus: "BOOKED",
      });

      expect(stale.status).toBe(409);
      expect(stale.body["code"]).toBe("QUEUE_MOVED_ON");
      // The two facts reception needs to be told "someone already moved this patient".
      expect(stale.body["currentStatus"]).toBe("WAITING");
      expect(stale.body["movedBy"]).toBe(clinicA.userId);
    });

    it("expectedStatus is required — a caller cannot opt out of the check", async () => {
      const id = await book(callerA, clinicA);
      const response = await patch(`/queue/${id}/check-in`, receptionToken, {});
      expect(response.status).toBe(400);
    });

    it("an undeclared field is rejected rather than quietly dropped", async () => {
      const id = await book(callerA, clinicA);
      const response = await patch(`/queue/${id}/check-in`, receptionToken, {
        expectedStatus: "BOOKED",
        tenantId: clinicB.tenantId,
      });
      expect(response.status).toBe(400);
    });
  });

  describe("cross-tenant is 404, and indistinguishable from never having existed", () => {
    it("another clinic's appointment id answers exactly as a nonexistent one does", async () => {
      const foreign = await book(callerB, clinicB);

      const crossTenant = await patch(`/queue/${foreign}/check-in`, receptionToken, {
        expectedStatus: "BOOKED",
      });
      const nonexistent = await patch(`/queue/${NEVER_EXISTED}/check-in`, receptionToken, {
        expectedStatus: "BOOKED",
      });

      expect(crossTenant.status).toBe(404);
      expect(nonexistent.status).toBe(404);
      // Indistinguishable, not merely both-404: a differently worded body would confirm the id is
      // real, which is the whole thing 404-not-403 exists to prevent.
      expect(crossTenant.body).toEqual(nonexistent.body);
    });

    it("the foreign appointment is untouched — the 404 refused, it did not silently act", async () => {
      const foreign = await book(callerB, clinicB);
      await patch(`/queue/${foreign}/check-in`, receptionToken, { expectedStatus: "BOOKED" });

      const row = await withTenant(clinicB.tenantId, actorFor(clinicB.userId), (tx) =>
        tx.appointment.findFirstOrThrow({ where: { id: foreign }, select: { status: true } }),
      );
      expect(row.status).toBe("BOOKED");
    });

    it("another clinic's queue is not visible through /queue/today", async () => {
      const foreign = await book(callerB, clinicB);
      await patch(`/queue/${foreign}/check-in`, tokenB, { expectedStatus: "BOOKED" });

      const seenFromA = await get(`/queue/today?date=${DATE}`, receptionToken);
      const ids = (seenFromA.body["entries"] as { appointmentId: string }[]).map(
        (e) => e.appointmentId,
      );
      expect(ids).not.toContain(foreign);
    });
  });

  describe("the permission guard is real", () => {
    /**
     * **The owner's queue is read-only — ruled 2026-09-06.**
     *
     * Asserted at the guard rather than by the absence of a button, for the reason Q20 records: a
     * UI-only permission fix removes the symptom that would have prompted the real one.
     *
     * The reads are asserted **first and deliberately**. "The owner loses queue actions" is one
     * ruling and "the owner cannot see the queue" would be a different, stricter one nobody made —
     * and the way to know which one shipped is to check that the board still answers 200.
     */
    it("an owner may read the queue and may not move anyone through it", async () => {
      const id = await book(callerA, clinicA);

      expect((await get(`/queue/today?date=${DATE}`, ownerToken)).status).toBe(200);
      expect((await get(`/no-shows/pending?date=${DATE}`, ownerToken)).status).toBe(200);

      for (const move of ["check-in", "start", "no-show"]) {
        const response = await patch(`/queue/${id}/${move}`, ownerToken, {
          expectedStatus: "BOOKED",
        });
        expect(response.status).toBe(403);
      }

      // Completing was already the doctor's alone since Q13; asserted here so the two rulings are
      // visible as one row rather than as separate facts a reader has to assemble.
      expect(
        (await patch(`/queue/${id}/complete`, ownerToken, { expectedStatus: "BOOKED" })).status,
      ).toBe(403);
    });

    /**
     * **The read/write split, asserted as one statement rather than two.**
     *
     * `patients.write` and `appointments.write` guarded seventeen reads between them until
     * 2026-09-06. The founder's objection was about naming rather than about the owner: a
     * capability called "write" deciding reads means every later permission decision on those
     * routes is made by a name that says the opposite of what it does — which is how
     * `appointments.write` came to gate `/queue/today`, a board.
     *
     * The value of the split is only visible in a test that checks **both halves against the same
     * token**: an owner who can still see everything and can no longer change anything. Either
     * assertion alone would pass under a botched split.
     */
    it("an owner reads the whole scheduling surface and writes none of it", async () => {
      const id = await book(callerA, clinicA);

      // Scoped to what this test module mounts. The same split is asserted for the doctors,
      // notifications, services and patient routes in their own specs -- reaching across modules
      // here would be testing the test module rather than the matrix.
      for (const path of [
        `/queue/today?date=${DATE}`,
        `/no-shows/pending?date=${DATE}`,
        `/schedule/day?doctorId=${clinicA.doctorId}&date=${DATE}`,
      ]) {
        expect((await get(path, ownerToken)).status).toBe(200);
      }

      // ...and every write on the same surface is refused at the guard.
      for (const move of ["cancel", "confirm"]) {
        const response = await patch(`/appointments/${id}/${move}`, ownerToken, { reason: "no" });
        expect(response.status).toBe(403);
      }
    });

    it("a role holding nothing is refused on every queue route", async () => {
      const id = await book(callerA, clinicA);

      const routes = [
        await patch(`/queue/${id}/check-in`, agentToken, { expectedStatus: "BOOKED" }),
        await patch(`/queue/${id}/start`, agentToken, { expectedStatus: "BOOKED" }),
        await patch(`/queue/${id}/complete`, agentToken, { expectedStatus: "BOOKED" }),
        await patch(`/queue/${id}/no-show`, agentToken, { expectedStatus: "BOOKED" }),
        await get(`/queue/today?date=${DATE}`, agentToken),
        await get(`/no-shows/pending?date=${DATE}`, agentToken),
      ];

      for (const response of routes) expect(response.status).toBe(403);
    });

    /**
     * **`PHASE-3.md` Q13, revisited 2026-09-03: completing a visit is the doctor's.**
     *
     * Not a UI rule. Before this, the queue offered reception أنهِ الكشف and the API answered 200 —
     * both layers agreed, and they agreed on the wrong thing. The screen was faithfully reflecting
     * the matrix, which is why the fix had to be the matrix and not the button: Q20 records that a
     * UI change resembling a permission fix is worse than none, because it removes the symptom that
     * would have prompted the real one.
     *
     * The reason is not tidiness about roles. Completing asserts the doctor finished and recorded
     * their notes, and under `PHASE-4.md` Q6 it also finalises the record — after it, adding a
     * forgotten sentence costs a `visit_revisions` row with a reason. A receptionist tidying the
     * board could do that to a doctor who is still typing.
     */
    it("reception cannot start or complete a consultation, and check-in is still theirs", async () => {
      const id = await book(callerA, clinicA);

      // Check-in first, so the refusals below cannot be mistaken for reception having lost the
      // queue altogether. Q40 left them check-in, transfer and no-show — the desk facts.
      expect((await patch(`/queue/${id}/check-in`, receptionToken, { expectedStatus: "BOOKED" })).status).toBe(200);

      // Q40, ruled 2026-09-09: which patient a doctor starts seeing is not a desk fact.
      const refusedStart = await patch(`/queue/${id}/start`, receptionToken, {
        expectedStatus: "WAITING",
      });
      expect(refusedStart.status).toBe(403);

      // Still WAITING, so the refusal did not move the patient on its way to refusing.
      const afterStart = await get(`/queue/today?date=${DATE}`, receptionToken);
      const waiting = ((afterStart.body["entries"] ?? []) as { appointmentId: string; status: string }[])
        .find((entry) => entry.appointmentId === id);
      expect(waiting?.status).toBe("WAITING");

      expect((await patch(`/queue/${id}/start`, doctorToken, { expectedStatus: "WAITING" })).status).toBe(200);

      const refused = await patch(`/queue/${id}/complete`, receptionToken, {
        expectedStatus: "IN_CONSULTATION",
      });
      expect(refused.status).toBe(403);

      // And the row is untouched -- a refusal that still moved the patient would be worse than one
      // that did not refuse at all.
      const board = await get(`/queue/today?date=${DATE}`, receptionToken);
      const entries = (board.body["entries"] ?? []) as { appointmentId: string; status: string }[];
      expect(entries.find((entry) => entry.appointmentId === id)?.status).toBe("IN_CONSULTATION");

      // The doctor can, which is what makes the refusal a rule about who rather than a broken route.
      const completed = await patch(`/queue/${id}/complete`, doctorToken, {
        expectedStatus: "IN_CONSULTATION",
      });
      expect(completed.status).toBe(200);
      expect(completed.body["status"]).toBe("COMPLETED");
    });

    it("an unauthenticated request never reaches the service", async () => {
      const response = await fetch(`${baseUrl}/queue/today?date=${DATE}`);
      expect(response.status).toBe(401);
    });

    it("the refused role changed nothing", async () => {
      const id = await book(callerA, clinicA);
      await patch(`/queue/${id}/check-in`, agentToken, { expectedStatus: "BOOKED" });

      const row = await withTenant(clinicA.tenantId, actorFor(clinicA.userId), (tx) =>
        tx.appointment.findFirstOrThrow({ where: { id }, select: { status: true } }),
      );
      expect(row.status).toBe("BOOKED");
    });
  });

  /**
   * `PHASE-3.md` §7: "two clients acting on the same row, exactly one winner, the loser told
   * *what happened* rather than 'illegal transition'".
   *
   * Rejections are inspected **as data** rather than awaited under `Promise.all`, which is the
   * lesson `PHASE-2.md` §17 paid for: under `Promise.all` a throw reports only the line that
   * awaited it, and twenty-six further runs produced no information about what was actually
   * thrown.
   */
  describe("compare-and-set under concurrency", () => {
    it("N clients check the same patient in: exactly one wins, the losers are told why", async () => {
      const id = await book(callerA, clinicA);

      const attempts = await Promise.allSettled(
        Array.from({ length: 6 }, () =>
          patch(`/queue/${id}/check-in`, receptionToken, { expectedStatus: "BOOKED" }),
        ),
      );

      const rejected = attempts.filter((a) => a.status === "rejected");
      // No attempt may throw. A rejection here is the shape of the open booking defect and must
      // name itself rather than costing another afternoon.
      expect(
        rejected.map((r) => {
          const error = (r as PromiseRejectedResult).reason as Error & { code?: string };
          return { name: error.name, code: error.code, message: error.message };
        }),
      ).toEqual([]);

      const responses = attempts
        .filter((a): a is PromiseFulfilledResult<{ status: number; body: Record<string, unknown> }> =>
          a.status === "fulfilled",
        )
        .map((a) => a.value);

      const winners = responses.filter((r) => r.status === 200);
      const losers = responses.filter((r) => r.status === 409);

      expect(winners).toHaveLength(1);
      expect(losers).toHaveLength(5);

      for (const loser of losers) {
        expect(loser.body["code"]).toBe("QUEUE_MOVED_ON");
        // Told what happened, not that they broke a rule.
        expect(loser.body["currentStatus"]).toBe("WAITING");
      }
    });

    /**
     * **What the compare-and-set is worth at *this* surface, stated precisely.**
     *
     * Q2's decisive case — `ARRIVED → WAITING` applied twice, legal both times, the second
     * silently overwriting the first `waiting_started_at` — is **not reachable through Phase 3's
     * endpoints**, because Q6 bundles both writes into check-in and gives `markWaiting()` no route
     * of its own. That case is asserted at the service level, in
     * `queue.integration.spec.ts`, and it stays there.
     *
     * Through HTTP, every stale action is *also* an illegal transition, so the state machine would
     * refuse it anyway. What the compare-and-set adds here is that the refusal says **what
     * happened** rather than that a rule was broken — which Q2 makes the point of the mechanism,
     * not a nicety, because "Dr Hisham already started this patient" is actionable and
     * "ILLEGAL_TRANSITION from IN_CONSULTATION" is not.
     *
     * So the assertion is that the two refusals are *distinguishable*. An earlier version of this
     * test claimed to prove the silent-overwrite case and passed with the guard disabled, which is
     * exactly the failure `CLAUDE.md` requires breaking the guard to catch.
     */
    it("a stale action and a genuinely illegal one are told apart", async () => {
      const stalePatient = await book(callerA, clinicA);
      await patch(`/queue/${stalePatient}/check-in`, receptionToken, { expectedStatus: "BOOKED" });
      const stale = await patch(`/queue/${stalePatient}/check-in`, receptionToken, {
        expectedStatus: "BOOKED",
      });

      const donePatient = await book(callerA, clinicA);
      await patch(`/queue/${donePatient}/check-in`, receptionToken, { expectedStatus: "BOOKED" });
      await patch(`/queue/${donePatient}/start`, doctorToken, { expectedStatus: "WAITING" });
      await patch(`/queue/${donePatient}/complete`, doctorToken, {
        expectedStatus: "IN_CONSULTATION",
      });
      // Correct expectation, genuinely illegal move: COMPLETED is terminal (Q15). Asked as the
      // doctor since Q40, or the 403 at the gate would arrive before the state machine was reached
      // and the test would be comparing a permission refusal with a staleness one.
      const illegal = await patch(`/queue/${donePatient}/start`, doctorToken, {
        expectedStatus: "COMPLETED",
      });

      expect(stale.status).toBe(409);
      expect(illegal.status).toBe(409);

      // Same status code, different answers — and only the stale one can name who moved it.
      expect(stale.body["code"]).toBe("QUEUE_MOVED_ON");
      expect(illegal.body["code"]).not.toBe("QUEUE_MOVED_ON");
      expect(stale.body["movedBy"]).toBe(clinicA.userId);
      expect(illegal.body["movedBy"]).toBeUndefined();
    });
  });
});
