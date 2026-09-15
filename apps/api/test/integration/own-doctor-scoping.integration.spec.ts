import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Module, ValidationPipe } from "@nestjs/common";
import { APP_INTERCEPTOR, NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { ActorContextInterceptor } from "../../src/common/actor-context.interceptor.ts";
import { AppointmentsController } from "../../src/modules/appointments/appointments.controller.ts";
import { issueAccessToken } from "../../src/modules/auth/jwt.ts";
import { QueueController } from "../../src/modules/queue/queue.controller.ts";
import { SchedulesController } from "../../src/modules/schedules/schedules.controller.ts";
import { prisma } from "../../src/prisma/client.ts";
import { injected } from "../../src/prisma/injected.ts";
import { withTenant } from "../../src/prisma/with-tenant.ts";
import { actorFor, createTestUser, seedClinic, teardownClinic, type ClinicFixture } from "./fixtures.ts";

/**
 * `own` scoping, over HTTP, for every reader that takes a `doctorId`.
 *
 * ## What this exists to prove
 *
 * `common/permissions.ts` states that `PermissionGuard` cannot decide `own`: it proves the role has
 * *some* access to the capability, and telling `own` from `full` needs the resource in hand, which a
 * route-level guard checking a JWT claim never has. `PHASE-1.md` turned that into a standing
 * requirement — **`own`-scoped routes ship with a test that the query is scoped, not that the guard
 * allowed the request.** The founder's framing: *the guard permits the request; the query has to
 * scope it.*
 *
 * Hiding the doctor picker in the web app proved nothing about any of this. A doctor who opened
 * devtools and edited a query parameter still read a colleague's day, 200. **So every assertion here
 * is made with a real `DOCTOR` token against a real colleague's id — the request a hidden control
 * cannot prevent.**
 *
 * ## Why the two doctors have different numbers of appointments
 *
 * Three for the caller, one for the colleague. Equal counts hide the exact bug this is about: a
 * filter that returns the wrong doctor's rows still returns the right *number* of them, so the
 * assertion passes while the scoping is inverted.
 *
 * ## Why a colleague's id and a nonexistent id are asserted to be identical
 *
 * A 404 that only appears for real-but-forbidden ids is an existence oracle: it tells the caller
 * which uuids name a doctor in this clinic. `PHASE-3.md`'s Definition of Done asks for
 * "404, and *indistinguishable* from a nonexistent id", which is the same reasoning as the
 * cross-tenant 404 in `CLAUDE.md`.
 */
@Module({
  controllers: [AppointmentsController, QueueController, SchedulesController],
  providers: [{ provide: APP_INTERCEPTOR, useClass: ActorContextInterceptor }],
})
class ScopingTestModule {}

describe("own scoping for every doctorId reader", () => {
  let app: NestExpressApplication;
  let baseUrl: string;
  let fixture: ClinicFixture;

  /** The colleague: a second doctor in the same tenant, whose rows must never come back. */
  let colleagueDoctorId: string;
  let doctorToken: string;
  let receptionToken: string;

  const DATE = "2026-09-01"; // A Tuesday, clear of any Egyptian DST transition.
  const NOON = new Date("2026-09-01T09:00:00Z"); // 12:00 Cairo, +03

  /**
   * A day comfortably in the past, for the no-show list. Those rows must be `BOOKED` (the only
   * statuses `MARK_NO_SHOW` is legal from) and past the grace period measured against the server's
   * real clock, which the endpoint supplies itself.
   */
  const PAST_DATE = "2026-08-25";
  const PAST_NOON = new Date("2026-08-25T09:00:00Z");

  /** A uuid that names nothing. The control for the existence-oracle assertions. */
  const NOWHERE = "00000000-0000-4000-8000-000000000000";

  const get = async (path: string, token: string): Promise<Response> =>
    fetch(`${baseUrl}${path}`, { headers: { authorization: `Bearer ${token}` } });

  beforeAll(async () => {
    fixture = await seedClinic();
    // A membership is unique per (user, tenant), so the colleague is a second human. That is also
    // the realistic shape: two doctors in one clinic are two logins.
    const colleagueUserId = await createTestUser();

    await withTenant(fixture.tenantId, actorFor(fixture.userId), async (tx) => {
      const colleagueMembershipId = randomUUID();
      await tx.membership.create({
        data: injected({
          id: colleagueMembershipId,
          userId: colleagueUserId,
          role: "DOCTOR",
          status: "ACTIVE",
        }),
      });

      colleagueDoctorId = randomUUID();
      await tx.doctor.create({
        data: injected({
          id: colleagueDoctorId,
          membershipId: colleagueMembershipId,
          specialty: "Cardiology",
          licenseNumber: `LIC-${colleagueDoctorId.replace(/-/g, "").slice(0, 8)}`,
          title: "Dr.",
        }),
      });

      // Deliberately unequal: three for the caller, one for the colleague.
      const make = async (doctorId: string, minute: number): Promise<void> => {
        const start = new Date(NOON.getTime() + minute * 60_000);
        await tx.appointment.create({
          data: injected({
            id: randomUUID(),
            patientId: fixture.patientId,
            doctorId,
            serviceId: fixture.serviceId,
            scheduledStart: start,
            scheduledEnd: new Date(start.getTime() + 30 * 60_000),
            status: "ARRIVED",
            source: "RECEPTION",
            arrivedAt: start,
            createdBy: fixture.userId,
            updatedBy: fixture.userId,
          }),
        });
      };
      await make(fixture.doctorId, 0);
      await make(fixture.doctorId, 30);
      await make(fixture.doctorId, 60);
      await make(colleagueDoctorId, 90);

      // For the no-show list: BOOKED and long past grace. Unequal again -- two and one.
      const makeBooked = async (doctorId: string, minute: number): Promise<void> => {
        const start = new Date(PAST_NOON.getTime() + minute * 60_000);
        await tx.appointment.create({
          data: injected({
            id: randomUUID(),
            patientId: fixture.patientId,
            doctorId,
            serviceId: fixture.serviceId,
            scheduledStart: start,
            scheduledEnd: new Date(start.getTime() + 30 * 60_000),
            status: "BOOKED",
            source: "RECEPTION",
            createdBy: fixture.userId,
            updatedBy: fixture.userId,
          }),
        });
      };
      await makeBooked(fixture.doctorId, 0);
      await makeBooked(fixture.doctorId, 30);
      await makeBooked(colleagueDoctorId, 60);
    });

    doctorToken = await issueAccessToken({
      sub: fixture.userId,
      // The membership the seeded doctor row hangs off. This is what makes the token a *specific*
      // doctor rather than merely a role.
      membershipId: fixture.membershipId,
      tenantId: fixture.tenantId,
      role: "DOCTOR",
    });

    receptionToken = await issueAccessToken({
      sub: fixture.userId,
      membershipId: randomUUID(),
      tenantId: fixture.tenantId,
      role: "RECEPTIONIST",
    });

    app = await NestFactory.create<NestExpressApplication>(ScopingTestModule, { logger: false });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    await app.listen(0, "127.0.0.1");
    baseUrl = `http://127.0.0.1:${((app.getHttpServer() as Server).address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    if (app !== undefined) await app.close();
    await teardownClinic(fixture);
    await prisma.$disconnect();
  });

  describe("the day view", () => {
    test("a doctor asking for a colleague's day gets 404, not the colleague's day", async () => {
      const response = await get(`/schedule/day?doctorId=${colleagueDoctorId}&date=${DATE}`, doctorToken);
      expect(response.status).toBe(404);
    });

    test("that 404 is indistinguishable from a doctor who does not exist", async () => {
      const forbidden = await get(`/schedule/day?doctorId=${colleagueDoctorId}&date=${DATE}`, doctorToken);
      const nonexistent = await get(`/schedule/day?doctorId=${NOWHERE}&date=${DATE}`, doctorToken);

      expect(forbidden.status).toBe(nonexistent.status);
      expect(await forbidden.json()).toEqual(await nonexistent.json());
    });

    test("a doctor asking for their own day still gets it", async () => {
      const response = await get(`/schedule/day?doctorId=${fixture.doctorId}&date=${DATE}`, doctorToken);
      expect(response.status).toBe(200);
    });

    test("reception may still read any doctor's day — the parameter is only pinned for a doctor", async () => {
      const response = await get(`/schedule/day?doctorId=${colleagueDoctorId}&date=${DATE}`, receptionToken);
      expect(response.status).toBe(200);
    });
  });

  describe("the week grid", () => {
    test("a doctor asking for a colleague's week gets 404", async () => {
      const response = await get(
        `/schedule/range?doctorId=${colleagueDoctorId}&from=${DATE}&to=${DATE}`,
        doctorToken,
      );
      expect(response.status).toBe(404);
    });

    test("reception may still read a colleague's week", async () => {
      const response = await get(
        `/schedule/range?doctorId=${colleagueDoctorId}&from=${DATE}&to=${DATE}`,
        receptionToken,
      );
      expect(response.status).toBe(200);
    });
  });

  describe("the queue", () => {
    /**
     * The queue's parameter is optional, which is what made it the worst of the three: a doctor did
     * not have to forge anything, only omit something, to receive the whole clinic.
     */
    test("a doctor omitting doctorId gets only their own patients, not the clinic's", async () => {
      const response = await get(`/queue/today?date=${DATE}`, doctorToken);
      expect(response.status).toBe(200);

      const body = (await response.json()) as { entries: { doctorId: string }[] };
      expect(body.entries).toHaveLength(3);
      expect(body.entries.every((e) => e.doctorId === fixture.doctorId)).toBe(true);
    });

    test("a doctor naming a colleague gets nothing, exactly as for a doctor who does not exist", async () => {
      const forbidden = await get(`/queue/today?date=${DATE}&doctorId=${colleagueDoctorId}`, doctorToken);
      const nonexistent = await get(`/queue/today?date=${DATE}&doctorId=${NOWHERE}`, doctorToken);

      expect(forbidden.status).toBe(nonexistent.status);
      expect(await forbidden.json()).toEqual(await nonexistent.json());
      expect(((await (await get(`/queue/today?date=${DATE}&doctorId=${colleagueDoctorId}`, doctorToken)).json()) as { entries: unknown[] }).entries).toHaveLength(0);
    });

    test("reception sees the whole room — all four, both doctors", async () => {
      const response = await get(`/queue/today?date=${DATE}`, receptionToken);
      expect(response.status).toBe(200);

      const body = (await response.json()) as { entries: { doctorId: string }[] };
      expect(body.entries).toHaveLength(4);
      expect(new Set(body.entries.map((e) => e.doctorId))).toEqual(
        new Set([fixture.doctorId, colleagueDoctorId]),
      );
    });
  });

  /**
   * The endpoint that takes **no** `doctorId` at all, which is why the first audit missed it: a
   * sweep for "endpoints accepting a doctorId" cannot see one that accepts none and returns every
   * doctor's patients by name. Both appointments here are `ARRIVED`, so neither is actually a
   * no-show candidate -- what is asserted is the *scope of the query*, which is the thing that was
   * wrong, and it is asserted by counting rows rather than by trusting the filter.
   */
  describe("the pending no-show list", () => {
    const candidatesFrom = async (token: string): Promise<{ doctorId: string }[]> => {
      const response = await get(`/no-shows/pending?date=${PAST_DATE}`, token);
      expect(response.status).toBe(200);
      const body = (await response.json()) as { candidates?: { doctorId: string }[] } | { doctorId: string }[];
      return Array.isArray(body) ? body : (body.candidates ?? []);
    };

    /**
     * Asserted first, and deliberately. Every other assertion in this block is satisfied by an empty
     * list, so without this one the whole block would pass against an endpoint that returned
     * nothing at all -- which is the vacuous-guard failure this project keeps finding.
     */
    test("reception sees candidates from both doctors — the list is not empty", async () => {
      const rows = await candidatesFrom(receptionToken);
      expect(rows).toHaveLength(3);
      expect(new Set(rows.map((c) => c.doctorId))).toEqual(
        new Set([fixture.doctorId, colleagueDoctorId]),
      );
    });

    test("a doctor gets only their own two, never the colleague's third", async () => {
      const rows = await candidatesFrom(doctorToken);
      expect(rows).toHaveLength(2);
      expect(rows.every((c) => c.doctorId === fixture.doctorId)).toBe(true);
    });
  });

  /**
   * **A duplicate, kept deliberately and labelled as one.** `getDoctorSchedule()` already narrowed
   * through `resolveWritableDoctor()` before any of this work, *and* the read was already asserted
   * by `schedules-own-scope.integration.spec.ts:146`. An earlier version of this block claimed to
   * be filling a coverage gap; there was no gap. It is kept only because it exercises the route
   * through this file's combined controller set, alongside the three readers that were genuinely
   * open — a reader comparing them should see the same shape of assertion for all four.
   */
  describe("the schedule read — already scoped and already covered elsewhere", () => {
    test("a doctor reading a colleague's schedule gets 404", async () => {
      const response = await get(`/doctors/${colleagueDoctorId}/schedule`, doctorToken);
      expect(response.status).toBe(404);
    });

    test("a doctor reading their own schedule gets it", async () => {
      const response = await get(`/doctors/${fixture.doctorId}/schedule`, doctorToken);
      expect(response.status).toBe(200);
    });

    test("that 404 is indistinguishable from a doctor who does not exist", async () => {
      const forbidden = await get(`/doctors/${colleagueDoctorId}/schedule`, doctorToken);
      const nonexistent = await get(`/doctors/${NOWHERE}/schedule`, doctorToken);

      expect(forbidden.status).toBe(nonexistent.status);
      expect(await forbidden.json()).toEqual(await nonexistent.json());
    });
  });

  /**
   * The book's two readers, over HTTP — which is the only layer that runs the query DTOs.
   *
   * `appointment-book.integration.spec.ts` calls `describeMonth()` directly, so it proved the SQL
   * and proved nothing about the route. Both DTO patterns shipped as `/^d{4}-d{2}$/`, missing the
   * backslashes: they match the literal string `dddd-dd`, so every real month and every real date
   * was a 400, and the client turned that into an empty calendar. The month count below is the
   * assertion that was missing — non-zero counts, through validation.
   */
  describe("the appointment book", () => {
    const MONTH = DATE.slice(0, 7);

    test("a month of seeded appointments comes back with non-zero counts", async () => {
      const response = await get(`/schedule/month?month=${MONTH}`, receptionToken);
      expect(response.status).toBe(200);

      const body = (await response.json()) as { days: { date: string; total: number }[] };
      const day = body.days.find((entry) => entry.date === DATE);
      // Four: three for the caller and the colleague's one, because reception sees the clinic.
      expect(day?.total).toBe(4);
    });

    test("a day of seeded appointments comes back with its bookings", async () => {
      const response = await get(`/schedule/day/bookings?date=${DATE}`, receptionToken);
      expect(response.status).toBe(200);

      const body = (await response.json()) as { bookings: { patientName: string }[] };
      expect(body.bookings).toHaveLength(4);
      expect(body.bookings.every((booking) => booking.patientName !== "")).toBe(true);
    });

    test("a doctor's month holds their own three, never the colleague's fourth", async () => {
      const response = await get(`/schedule/month?month=${MONTH}`, doctorToken);
      expect(response.status).toBe(200);

      const body = (await response.json()) as {
        days: { date: string; total: number }[];
        doctors: { id: string }[];
        readOnly: boolean;
      };
      expect(body.days.find((entry) => entry.date === DATE)?.total).toBe(3);
      expect(body.doctors.map((doctor) => doctor.id)).toEqual([fixture.doctorId]);
      expect(body.readOnly).toBe(true);
    });

    test("a doctor naming a colleague gets 404 on the month, not the colleague's month", async () => {
      const response = await get(`/schedule/month?month=${MONTH}&doctorId=${colleagueDoctorId}`, doctorToken);
      expect(response.status).toBe(404);
    });

    test("a doctor naming a colleague gets 404 on the day, not the colleague's day", async () => {
      const response = await get(`/schedule/day/bookings?date=${DATE}&doctorId=${colleagueDoctorId}`, doctorToken);
      expect(response.status).toBe(404);
    });

    test("both 404s are indistinguishable from a doctor who does not exist", async () => {
      const month = await get(`/schedule/month?month=${MONTH}&doctorId=${colleagueDoctorId}`, doctorToken);
      const monthNowhere = await get(`/schedule/month?month=${MONTH}&doctorId=${NOWHERE}`, doctorToken);
      expect(month.status).toBe(monthNowhere.status);
      expect(await month.json()).toEqual(await monthNowhere.json());

      const day = await get(`/schedule/day/bookings?date=${DATE}&doctorId=${colleagueDoctorId}`, doctorToken);
      const dayNowhere = await get(`/schedule/day/bookings?date=${DATE}&doctorId=${NOWHERE}`, doctorToken);
      expect(day.status).toBe(dayNowhere.status);
      expect(await day.json()).toEqual(await dayNowhere.json());
    });

    test("reception may still narrow to any doctor — the parameter is only pinned for a doctor", async () => {
      const response = await get(`/schedule/month?month=${MONTH}&doctorId=${colleagueDoctorId}`, receptionToken);
      expect(response.status).toBe(200);

      const body = (await response.json()) as { days: { date: string; total: number }[]; readOnly: boolean };
      expect(body.days.find((entry) => entry.date === DATE)?.total).toBe(1);
      expect(body.readOnly).toBe(false);
    });
  });
});
