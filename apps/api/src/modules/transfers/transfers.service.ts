import { randomUUID } from "node:crypto";
import type { TransferStatus } from "../../generated/prisma/enums.ts";
import { resolveReadableDoctorId } from "../../common/doctor-scope.ts";
import type { RefusalParams } from "../../common/refusals.ts";
import { injected } from "../../prisma/injected.ts";
import { withTenant, type TransactionClient } from "../../prisma/with-tenant.ts";
import type { CallerContext } from "../appointments/appointments.service.ts";
import { recordNotification } from "../notifications/notifications.service.ts";
import { appointmentClosesRequest, effectiveStatus, transition } from "./domain/transfer-state.ts";

/**
 * Patient transfers — the service. `PHASE-3.md` Q16/Q17/Q21, `SCHEMA-DECISIONS.md` D24.
 *
 * Refusals are values with machine-readable reasons, never framework exceptions: the controller
 * maps them, and the AI tool layer will call the same functions later without catching HTTP errors.
 */

/**
 * `NOT_THE_RECEIVING_DOCTOR` was here and is gone: it was declared and never returned. A caller who
 * is not the receiving doctor gets `NOT_FOUND`, deliberately — a 403 would confirm the request
 * exists and name a patient they have no business knowing about. The controller says so at the
 * `NOT_FOUND` branch; the dead member made it look as though a second answer existed.
 */
export type TransferRefusalReason =
  | "NOT_FOUND"
  | "ALREADY_OPEN"
  | "ALREADY_DECIDED"
  | "REASON_REQUIRED"
  | "SAME_DOCTOR";

export type TransferResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: TransferRefusalReason; params: RefusalParams };

export interface TransferView {
  id: string;
  patientId: string;
  patientName: string;
  fromDoctorId: string;
  fromDoctorName: string;
  toDoctorId: string;
  toDoctorName: string;
  appointmentId: string;
  status: TransferStatus;
  reason: string | null;
  decisionNote: string | null;
  /** When the request was raised. The screen turns this into "waiting 12 minutes" (see below). */
  requestedAt: Date;
  decidedAt: Date | null;
}

const NAME_SELECT = {
  select: { title: true, membership: { select: { user: { select: { fullName: true } } } } },
} as const;

interface TransferRow {
  id: string;
  patientId: string;
  fromDoctorId: string;
  toDoctorId: string;
  appointmentId: string;
  status: TransferStatus;
  reason: string | null;
  decisionNote: string | null;
  createdAt: Date;
  decidedAt: Date | null;
  patient: { fullNameAr: string };
  fromDoctor: { title: string; membership: { user: { fullName: string } } };
  toDoctor: { title: string; membership: { user: { fullName: string } } };
  appointment: { status: string };
}

function toView(row: TransferRow): TransferView {
  return {
    id: row.id,
    patientId: row.patientId,
    patientName: row.patient.fullNameAr,
    fromDoctorId: row.fromDoctorId,
    fromDoctorName: `${row.fromDoctor.title} ${row.fromDoctor.membership.user.fullName}`,
    toDoctorId: row.toDoctorId,
    toDoctorName: `${row.toDoctor.title} ${row.toDoctor.membership.user.fullName}`,
    appointmentId: row.appointmentId,
    // Read through effectiveStatus, so a PENDING row whose appointment already closed can never be
    // shown as open or acted on -- belt and braces over the LAPSE write. D24.
    status: effectiveStatus({
      status: row.status,
      decidedAt: row.decidedAt,
      appointmentStatus: row.appointment.status as never,
    }),
    reason: row.reason,
    decisionNote: row.decisionNote,
    requestedAt: row.createdAt,
    decidedAt: row.decidedAt,
  };
}

const INCLUDE = {
  patient: { select: { fullNameAr: true } },
  fromDoctor: NAME_SELECT,
  toDoctor: NAME_SELECT,
  appointment: { select: { status: true } },
} as const;

/**
 * Which channel a transfer event came through.
 *
 * `Notification.source` is `AppointmentSource`, not free text, so this maps the acting role onto
 * that enum rather than inventing a value. It is derived from the validated JWT role, never from
 * the request -- the same rule as everything else that says who did something.
 */
function sourceFor(role: string): "RECEPTION" | "DOCTOR" {
  return role === "DOCTOR" ? "DOCTOR" : "RECEPTION";
}

/** The doctor row belonging to this caller, or null when the caller is not a doctor here. */
async function callerDoctorId(tx: TransactionClient, membershipId: string): Promise<string | null> {
  const doctor = await tx.doctor.findFirst({ where: { membershipId }, select: { id: true } });
  return doctor?.id ?? null;
}

/**
 * Reception raises a request against an appointment.
 *
 * The appointment names the from-doctor: a transfer is *from whoever the patient is booked with*,
 * never from a doctor the request supplies, for the same reason `tenantId` is never taken from a
 * request body. Sending a `fromDoctorId` would let a caller describe a handover that is not the one
 * on the board.
 */
export async function requestTransfer(
  caller: CallerContext,
  input: { appointmentId: string; toDoctorId: string; reason?: string | null },
): Promise<TransferResult<TransferView>> {
  return withTenant(caller.tenantId, caller.actor, async (tx) => {
    const appointment = await tx.appointment.findFirst({
      where: { id: input.appointmentId },
      select: { id: true, patientId: true, doctorId: true, status: true },
    });
    if (appointment === null) {
      return {
        ok: false as const,
        code: "NOT_FOUND" as const,
        params: { resource: "appointment" } as const,
      };
    }

    // ---- The guard permitted the request; this scopes it. ----
    //
    // `appointments.write` is `DOCTOR: FULL`, so the route guard admits every doctor in the tenant,
    // and the from-doctor below is read off the appointment rather than supplied. Without this
    // check a doctor could raise a transfer on a *colleague's* patient naming **themselves** as the
    // destination, then -- as the receiving doctor, who is the one who decides -- accept it, and
    // walk away with a thirty-day clinical grant over a patient they were never involved with. The
    // DTO's refusal to accept a `fromDoctorId` does not prevent that: it fixes *whose* handover is
    // described, not *who may describe one*.
    //
    // Routed through `resolveReadableDoctorId` rather than a local `role === "DOCTOR"` test, so this
    // is the fifth call to the one function that owns the rule instead of a fifth chance to forget
    // it -- `common/doctor-scope.ts` says exactly why. Reception, admins and owners are not pinned
    // and pass through unchanged; they raise most requests.
    //
    // 404 with the *same sentence* as a missing appointment, never 403: a 403 would confirm the
    // appointment exists and tell a doctor which of a colleague's patients are in the building.
    const permittedDoctorId = await resolveReadableDoctorId(tx, caller, appointment.doctorId);
    if (permittedDoctorId === null) {
      return {
        ok: false as const,
        code: "NOT_FOUND" as const,
        params: { resource: "appointment" } as const,
      };
    }

    const toDoctor = await tx.doctor.findFirst({ where: { id: input.toDoctorId }, select: { id: true } });
    if (toDoctor === null) {
      return {
        ok: false as const,
        code: "NOT_FOUND" as const,
        params: { resource: "doctor" } as const,
      };
    }
    if (toDoctor.id === appointment.doctorId) {
      return {
        ok: false as const,
        code: "SAME_DOCTOR" as const,
        params: {},
      };
    }

    // The database has a partial unique index enforcing this too. Checked here as well so the desk
    // gets a sentence rather than a constraint violation -- the index is what makes the race
    // unwinnable, this is what makes the ordinary case readable.
    const open = await tx.patientTransfer.findFirst({
      where: { patientId: appointment.patientId, status: "PENDING" },
      select: { id: true },
    });
    if (open !== null) {
      return {
        ok: false as const,
        code: "ALREADY_OPEN" as const,
        params: {},
      };
    }

    const id = randomUUID();
    await tx.patientTransfer.create({
      data: injected({
        id,
        patientId: appointment.patientId,
        fromDoctorId: appointment.doctorId,
        toDoctorId: input.toDoctorId,
        appointmentId: appointment.id,
        status: "PENDING",
        reason: input.reason ?? null,
        initiatedByMembershipId: caller.membershipId,
      }),
    });

    await recordNotification(tx, caller.actor.userId, {
      kind: "TRANSFER_REQUESTED",
      appointmentId: appointment.id,
      patientId: appointment.patientId,
      source: sourceFor(caller.role),
      occurredAt: new Date(),
      payload: { transferId: id, toDoctorId: input.toDoctorId },
    });

    const row = await tx.patientTransfer.findFirstOrThrow({ where: { id }, include: INCLUDE });
    return { ok: true as const, value: toView(row as TransferRow) };
  });
}

/**
 * Accept or reject. **Only the receiving doctor may decide** — the whole point of the request is
 * that somebody else is being asked to take the patient on.
 *
 * The write is a **compare-and-set**: `updateMany` filtered on `status: "PENDING"`, and a zero count
 * means somebody else got there first. Same shape as the queue's Q2 move, and for the same reason —
 * two people holding the screen must not both succeed, and the loser must be told *what happened*
 * rather than "illegal transition".
 */
export async function decideTransfer(
  caller: CallerContext,
  transferId: string,
  event: "ACCEPT" | "REJECT",
  input: { decisionNote?: string | null; now: Date },
): Promise<TransferResult<TransferView>> {
  return withTenant(caller.tenantId, caller.actor, async (tx) => {
    const existing = await tx.patientTransfer.findFirst({ where: { id: transferId }, include: INCLUDE });
    if (existing === null) {
      return {
        ok: false as const,
        code: "NOT_FOUND" as const,
        params: { resource: "transfer" } as const,
      };
    }

    const mine = await callerDoctorId(tx, caller.membershipId);
    // 404, not 403: a 403 would confirm that this transfer exists and name a patient the caller has
    // no business knowing about. Same reasoning as the cross-tenant 404 in CLAUDE.md.
    if (mine === null || mine !== existing.toDoctorId) {
      return {
        ok: false as const,
        code: "NOT_FOUND" as const,
        params: { resource: "transfer" } as const,
      };
    }

    /**
     * Ruled: a rejection must carry a reason. Reception has to decide whether to retry with a
     * different doctor or escalate, and "no" on its own does not tell them which.
     */
    const note = input.decisionNote?.trim() ?? "";
    if (event === "REJECT" && note.length === 0) {
      return {
        ok: false as const,
        code: "REASON_REQUIRED" as const,
        params: {},
      };
    }

    const current = effectiveStatus({
      status: existing.status,
      decidedAt: existing.decidedAt,
      appointmentStatus: existing.appointment.status as never,
    });
    const step = transition(current, event);
    if (!step.ok) return { ok: false as const, code: step.code, params: step.params };

    const claimed = await tx.patientTransfer.updateMany({
      where: { id: transferId, status: "PENDING" },
      data: {
        status: step.next,
        decidedAt: input.now,
        decidedByMembershipId: caller.membershipId,
        decisionNote: note.length === 0 ? null : note,
      },
    });
    if (claimed.count === 0) {
      return {
        ok: false as const,
        code: "ALREADY_DECIDED" as const,
        params: { status: existing.status },
      };
    }

    await recordNotification(tx, caller.actor.userId, {
      kind: event === "ACCEPT" ? "TRANSFER_ACCEPTED" : "TRANSFER_REJECTED",
      appointmentId: existing.appointmentId,
      patientId: existing.patientId,
      source: sourceFor(caller.role),
      occurredAt: input.now,
      payload: { transferId, decision: step.next, decisionNote: note.length === 0 ? null : note },
    });

    const row = await tx.patientTransfer.findFirstOrThrow({ where: { id: transferId }, include: INCLUDE });
    return { ok: true as const, value: toView(row as TransferRow) };
  });
}

/**
 * Closes any open request on an appointment that has just reached a terminal status.
 *
 * Called from inside the queue's own transaction, not from a job — D24's whole argument. And it
 * **notifies**, because a request that closes itself quietly is worse than one that stays visibly
 * open: from the desk it is indistinguishable from still-pending.
 */
export async function lapseOpenRequests(
  tx: TransactionClient,
  actorUserId: string,
  appointmentId: string,
  appointmentStatus: string,
  now: Date,
): Promise<number> {
  if (!appointmentClosesRequest(appointmentStatus as never)) return 0;

  const open = await tx.patientTransfer.findMany({
    where: { appointmentId, status: "PENDING" },
    select: { id: true, patientId: true },
  });
  if (open.length === 0) return 0;

  await tx.patientTransfer.updateMany({
    where: { appointmentId, status: "PENDING" },
    data: { status: "LAPSED", decidedAt: now },
  });

  for (const request of open) {
    await recordNotification(tx, actorUserId, {
      kind: "TRANSFER_LAPSED",
      appointmentId,
      patientId: request.patientId,
      // The appointment's own transition caused this, and the actor is whoever moved the queue.
      source: "RECEPTION",
      occurredAt: now,
      payload: { transferId: request.id, appointmentStatus },
    });
  }
  return open.length;
}

/**
 * The three surfaces, from one query.
 *
 * Reception sees every request in the clinic — they raise them, so they must see them sitting
 * unanswered. A doctor sees only requests they are a party to, **from or to**: the originating
 * doctor needs to know their patient is being handed on as much as the receiving one needs to
 * answer. That is the founder's "visible from all three", and it is one endpoint rather than three
 * because three would be three chances for them to disagree.
 */
export async function listTransfers(
  caller: CallerContext,
  input: { openOnly: boolean },
): Promise<TransferView[]> {
  return withTenant(caller.tenantId, caller.actor, async (tx) => {
    const mine = caller.role === "DOCTOR" ? await callerDoctorId(tx, caller.membershipId) : null;

    // A DOCTOR with no doctors row sees nothing, rather than falling through to "everything".
    if (caller.role === "DOCTOR" && mine === null) return [];

    const rows = await tx.patientTransfer.findMany({
      where: {
        ...(mine === null ? {} : { OR: [{ fromDoctorId: mine }, { toDoctorId: mine }] }),
        ...(input.openOnly ? { status: "PENDING" } : {}),
      },
      include: INCLUDE,
      orderBy: { createdAt: "asc" },
    });

    const views = rows.map((row) => toView(row as TransferRow));
    // Filtered after mapping, because effectiveStatus can demote a stored PENDING to LAPSED and an
    // "open requests" list must not show one that is not open.
    return input.openOnly ? views.filter((view) => view.status === "PENDING") : views;
  });
}
