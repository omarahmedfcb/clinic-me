import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { AppModule } from "../../src/app.module.ts";
import { todayInClinic } from "../../src/common/clinic-time.ts";
import { refusingValidationPipe } from "../../src/common/validation-pipe.ts";
import { lockDoctorDay } from "../../src/modules/appointments/slot-day-lock.ts";
import { addDays } from "../../src/modules/appointments/domain/zoned-time.ts";
import { issueAccessToken } from "../../src/modules/auth/jwt.ts";
import { prisma } from "../../src/prisma/client.ts";
import { injected } from "../../src/prisma/injected.ts";
import { type TransactionClient, withTenant } from "../../src/prisma/with-tenant.ts";
import { actorFor, seedClinic, teardownClinic, type ClinicFixture } from "./fixtures.ts";

// D25: every doctor-day writer takes the lock. Reception books the doctor's only slot on the follow-up
// day and holds its transaction open; the completion must wait, see the slot gone, and book elsewhere.
describe("a follow-up takes the doctor-day lock, as every doctor-day writer must", () => {
  let app: NestExpressApplication;
  let baseUrl = "";
  let clinic: ClinicFixture;
  let token = "";
  let requested = "";

  const as = <T>(work: (tx: TransactionClient) => Promise<T>): Promise<T> =>
    withTenant(clinic.tenantId, actorFor(clinic.userId), work);
  const call = (method: string, path: string, body?: unknown): Promise<Response> =>
    fetch(`${baseUrl}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  /** Resolves once some backend of this database is waiting on a lock: the completion has reached its write. */
  async function someoneIsWaiting(): Promise<void> {
    for (let i = 0; i < 200; i += 1) {
      const [row] = await prisma.$queryRaw<{ n: number }[]>`
        SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`;
      if (row!.n > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("the completion never blocked on the held doctor-day");
  }

  beforeAll(async () => {
    process.env["ATTACHMENTS_STORAGE_ROOT"] ??= process.cwd();
    clinic = await seedClinic();
    const tenant = await as((tx) => tx.tenant.findUniqueOrThrow({ where: { id: clinic.tenantId }, select: { timezone: true } }));
    requested = addDays(todayInClinic(tenant.timezone), 3);
    // One thirty-minute window on that weekday: one slot, which reception is about to take.
    await as((tx) =>
      tx.scheduleTemplate.create({
        data: injected({
          id: randomUUID(),
          branchId: clinic.branchId,
          doctorId: clinic.doctorId,
          weekday: new Date(`${requested}T00:00:00Z`).getUTCDay(),
          startTime: new Date("1970-01-01T09:00:00Z"),
          endTime: new Date("1970-01-01T09:30:00Z"),
          validFrom: new Date("2020-01-01"),
        }),
      }),
    );
    token = await issueAccessToken({ sub: clinic.userId, membershipId: clinic.membershipId, tenantId: clinic.tenantId, role: "DOCTOR" });

    app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: false });
    app.useGlobalPipes(refusingValidationPipe());
    await app.listen(0);
    baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await app?.close();
    await teardownClinic(clinic);
  });

  test("reception holds the only slot; the completion waits, then books the next week, with no 500", async () => {
    const query = `doctorId=${clinic.doctorId}&serviceId=${clinic.serviceId}&date=${requested}`;
    const { slots } = (await (await call("GET", `/availability?${query}`)).json()) as { slots: { start: string; end: string }[] };
    expect(slots).toHaveLength(1);
    const contested = { start: new Date(slots[0]!.start), end: new Date(slots[0]!.end) };

    const appointmentId = randomUUID();
    const start = new Date(Date.now() - 86_400_000);
    await as((tx) =>
      tx.appointment.create({
        data: injected({ id: appointmentId, branchId: clinic.branchId, patientId: clinic.patientId, doctorId: clinic.doctorId, serviceId: clinic.serviceId, scheduledStart: start, scheduledEnd: new Date(start.getTime() + 20 * 60_000), status: "IN_CONSULTATION", source: "RECEPTION", createdBy: clinic.userId, updatedBy: clinic.userId }),
      }),
    );
    const draft = (await (await call("POST", `/appointments/${appointmentId}/visit/draft`)).json()) as { id: string; revision: number };

    let release = (): void => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    let inserted = (): void => {};
    const booked = new Promise<void>((resolve) => (inserted = resolve));
    const reception = as(async (tx) => {
      await lockDoctorDay(tx, { tenantId: clinic.tenantId, doctorId: clinic.doctorId, at: contested.start });
      await tx.appointment.create({
        data: injected({ id: randomUUID(), branchId: clinic.branchId, patientId: clinic.patientId, doctorId: clinic.doctorId, serviceId: clinic.serviceId, scheduledStart: contested.start, scheduledEnd: contested.end, status: "BOOKED", source: "RECEPTION", createdBy: clinic.userId, updatedBy: clinic.userId }),
      });
      inserted();
      await held;
    });
    await booked;

    const completion = call("POST", `/appointments/${appointmentId}/visit/${draft.id}/complete`, { expectedRevision: draft.revision, followUpDate: requested });
    await someoneIsWaiting();
    release();
    await reception;

    const response = await completion;
    expect(response.status).toBe(201);
    const { followUpBooking } = (await response.json()) as { followUpBooking: { booked: boolean; date: string } };
    expect(followUpBooking).toMatchObject({ booked: true, date: addDays(requested, 7) });
    const onTheContestedSlot = await as((tx) => tx.appointment.count({ where: { doctorId: clinic.doctorId, scheduledStart: contested.start } }));
    expect(onTheContestedSlot).toBe(1);
  });
});
