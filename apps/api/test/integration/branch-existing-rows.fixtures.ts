// One case per scoped write route that acts on an existing row: who may call it, and how to build a row
// in a given branch for it. Every row names its branch: since branches stage 5 nothing fills one in.
import { randomUUID } from "node:crypto";
import type { MembershipRole } from "../../src/generated/prisma/enums.ts";
import { todayInClinic } from "../../src/common/clinic-time.ts";
import { issueAccessToken } from "../../src/modules/auth/jwt.ts";
import { mintSlotToken } from "../../src/modules/appointments/slot-token.ts";
import { injected } from "../../src/prisma/injected.ts";
import { type TransactionClient, withTenant } from "../../src/prisma/with-tenant.ts";
import { actorFor, createTestUser, type ClinicFixture } from "./fixtures.ts";

export type Actor = "reception" | "admin" | "doctor" | "bot";
export type Tokens = Record<Actor, string>;

export interface World {
  clinic: ClinicFixture;
  tokens: Tokens;
  users: string[];
  today: string;
  /** Where this world's rows are made: the callers' one branch, or a single-branch clinic's only one. */
  inBranch: string;
}

export interface Built {
  path: string;
  body?: unknown;
  /** The stored row the route acts on, which a refusal is recorded against. */
  entityId: string;
}

export interface Case {
  actor: Actor;
  /** The handler's own not-found resource: out of scope reads exactly as missing. */
  resource: "appointment" | "visit" | "charge" | "exception";
  /** `caller` mints anything signed for the caller's own clinic; it differs from `world` only cross-tenant. */
  build: (world: World, branchId: string, caller?: World) => Promise<Built>;
}

export const as = <T>(clinic: ClinicFixture, work: (tx: TransactionClient) => Promise<T>): Promise<T> =>
  withTenant(clinic.tenantId, actorFor(clinic.userId), work);

let minute = 0;
/** A distinct five-minute window per row, so one doctor's rows never meet the exclusion constraint. */
function windowOn(day: string): { start: Date; end: Date } {
  minute += 6;
  const start = new Date(Date.parse(`${day}T09:00:00Z`) + minute * 60_000);
  return { start, end: new Date(start.getTime() + 5 * 60_000) };
}
const shiftDay = (day: string, days: number): string =>
  new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

export async function appointment(
  world: World,
  branchId: string,
  status: string,
  dayOffset = 0,
  patientId = world.clinic.patientId,
): Promise<string> {
  const { start, end } = windowOn(shiftDay(world.today, dayOffset));
  const id = randomUUID();
  await as(world.clinic, (tx) =>
    tx.appointment.create({
      data: injected({
        id,
        branchId,
        patientId,
        doctorId: world.clinic.doctorId,
        serviceId: world.clinic.serviceId,
        scheduledStart: start,
        scheduledEnd: end,
        status: status as never,
        source: "RECEPTION",
        createdBy: world.clinic.userId,
        updatedBy: world.clinic.userId,
      }),
    }),
  );
  return id;
}

export async function visitOn(world: World, appointmentId: string): Promise<string> {
  const id = randomUUID();
  await as(world.clinic, (tx) =>
    tx.visit.create({
      data: injected({ id, patientId: world.clinic.patientId, doctorId: world.clinic.doctorId, appointmentId, status: "DRAFT", createdBy: world.clinic.userId }),
    }),
  );
  return id;
}

async function charge(world: World, branchId: string): Promise<string> {
  const visitId = await visitOn(world, await appointment(world, branchId, "COMPLETED", -2));
  return as(world.clinic, async (tx) => (await tx.visitCharge.create({ data: injected({ id: randomUUID(), visitId, patientId: world.clinic.patientId }) })).id);
}

/** A token for a future slot in the given branch. */
function slotToken(world: World, branchId: string): string {
  const { start, end } = windowOn(shiftDay(world.today, 3));
  return mintSlotToken(
    { tenantId: world.clinic.tenantId, doctorId: world.clinic.doctorId, serviceId: world.clinic.serviceId, branchId, startMs: start.getTime(), endMs: end.getTime() },
    new Date(),
  );
}

const queueMove = (move: string, expectedStatus: string, actor: Actor, dayOffset = 0): Case => ({
  actor,
  resource: "appointment",
  build: async (w, branchId) => {
    const id = await appointment(w, branchId, expectedStatus, dayOffset);
    return { path: `/queue/${id}/${move}`, body: { expectedStatus }, entityId: id };
  },
});

const onCharge = (suffix: string, body: unknown, actor: Actor, resource: Case["resource"]): Case => ({
  actor,
  resource,
  build: async (w, branchId) => {
    const id = await charge(w, branchId);
    return { path: `/charges/${id}${suffix}`, body, entityId: id };
  },
});

const reschedule = (prefix: string, actor: Actor): Case => ({
  actor,
  resource: "appointment",
  build: async (w, branchId, caller = w) => {
    const id = await appointment(w, branchId, "BOOKED", 2);
    // The new slot is in the caller's own branch, so only the stored row can be out of scope.
    return { path: `${prefix}/${id}/reschedule`, body: { slotToken: slotToken(caller, caller.inBranch) }, entityId: id };
  },
});

export const CASES: Record<string, Case> = {
  "PATCH /appointments/:id/cancel": {
    actor: "reception",
    resource: "appointment",
    build: async (w, b) => {
      const id = await appointment(w, b, "BOOKED", 2);
      return { path: `/appointments/${id}/cancel`, body: { reason: "test" }, entityId: id };
    },
  },
  "PATCH /appointments/:id/confirm": {
    actor: "reception",
    resource: "appointment",
    build: async (w, b) => {
      const id = await appointment(w, b, "BOOKED", 2);
      return { path: `/appointments/${id}/confirm`, entityId: id };
    },
  },
  "PATCH /appointments/:id/reschedule": reschedule("/appointments", "reception"),
  "POST /bot/appointments/:id/cancel": {
    actor: "bot",
    resource: "appointment",
    build: async (w, b) => {
      const id = await appointment(w, b, "BOOKED", 2);
      return { path: `/bot/appointments/${id}/cancel`, body: { reason: "test" }, entityId: id };
    },
  },
  "POST /bot/appointments/:id/reschedule": reschedule("/bot/appointments", "bot"),
  "PATCH /queue/:id/check-in": queueMove("check-in", "BOOKED", "reception"),
  "PATCH /queue/:id/no-show": queueMove("no-show", "BOOKED", "reception", -1),
  "PATCH /queue/:id/start": queueMove("start", "WAITING", "doctor"),
  "PATCH /queue/:id/pause": queueMove("pause", "IN_CONSULTATION", "doctor"),
  "PATCH /queue/:id/resume": queueMove("resume", "PAUSED", "doctor"),
  "PATCH /queue/:id/complete": queueMove("complete", "IN_CONSULTATION", "doctor"),
  "PUT /appointments/:id/visit/:visitId/pricing": {
    actor: "doctor",
    resource: "visit",
    build: async (w, b) => {
      const appointmentId = await appointment(w, b, "IN_CONSULTATION");
      const visitId = await visitOn(w, appointmentId);
      return { path: `/appointments/${appointmentId}/visit/${visitId}/pricing`, body: { adjustmentMinor: null }, entityId: visitId };
    },
  },
  "PUT /charges/:chargeId/discount": onCharge("/discount", { discountMinor: 0, reason: "test" }, "reception", "visit"),
  "PUT /charges/:chargeId/discount/authorised": onCharge("/discount/authorised", { discountMinor: 0, reason: "test" }, "admin", "visit"),
  "PUT /charges/:chargeId/split": onCharge("/split", { payerShareMinor: 0 }, "reception", "visit"),
  "POST /charges/:chargeId/credit": onCharge("/credit", { amountMinor: 1 }, "reception", "charge"),
  "POST /payments": {
    actor: "reception",
    resource: "visit",
    build: async (w, b) => {
      const id = await charge(w, b);
      return { path: "/payments", body: { patientId: w.clinic.patientId, chargeId: id, amountMinor: 1, method: "CASH" }, entityId: id };
    },
  },
  "DELETE /doctors/:doctorId/schedule/exceptions/:exceptionId": {
    actor: "admin",
    resource: "exception",
    build: async (w, b) => {
      const id = randomUUID();
      await as(w.clinic, (tx) =>
        tx.scheduleException.create({ data: injected({ id, doctorId: w.clinic.doctorId, date: new Date(`${shiftDay(w.today, 30)}T00:00:00Z`), type: "BLOCKED", branchId: b, scope: "ONE_BRANCH" }) }),
      );
      return { path: `/doctors/${w.clinic.doctorId}/schedule/exceptions/${id}`, entityId: id };
    },
  },
};

/** Builds the four callers, each scoped as narrowly as its role allows, to `onlyBranch` when given. */
export async function worldFor(clinic: ClinicFixture, onlyBranch?: string): Promise<World> {
  const users: string[] = [];
  const tenant = await as(clinic, (tx) => tx.tenant.findUniqueOrThrow({ where: { id: clinic.tenantId }, select: { timezone: true } }));
  async function member(role: MembershipRole): Promise<string> {
    const userId = await createTestUser();
    users.push(userId);
    const membershipId = randomUUID();
    await as(clinic, async (tx) => {
      await tx.membership.create({ data: injected({ id: membershipId, userId, role, status: "ACTIVE" }) });
      await tx.membership.update({ where: { id: membershipId }, data: { branchScope: "SELECTED" } });
      if (onlyBranch === undefined) return;
      await tx.membershipBranch.deleteMany({ where: { membershipId } });
      await tx.membershipBranch.create({ data: injected({ id: randomUUID(), membershipId, branchId: onlyBranch }) });
    });
    return issueAccessToken({ sub: userId, membershipId, tenantId: clinic.tenantId, role });
  }
  if (onlyBranch !== undefined) {
    await as(clinic, (tx) =>
      tx.scheduleTemplate.create({
        data: injected({
          id: randomUUID(),
          branchId: onlyBranch,
          doctorId: clinic.doctorId,
          weekday: 6,
          startTime: new Date("1970-01-01T06:00:00Z"),
          endTime: new Date("1970-01-01T07:00:00Z"),
          validFrom: new Date("2020-01-01"),
        }),
      }),
    );
  }
  const tokens: Tokens = {
    reception: await member("RECEPTIONIST"),
    admin: await member("ADMIN"),
    bot: await member("AI_AGENT"),
    // The fixture's own doctor, SCHEDULED: with templates only in `onlyBranch`, or none at all.
    doctor: await issueAccessToken({ sub: clinic.userId, membershipId: clinic.membershipId, tenantId: clinic.tenantId, role: "DOCTOR" }),
  };
  return { clinic, tokens, users, today: todayInClinic(tenant.timezone), inBranch: onlyBranch ?? clinic.branchId };
}
