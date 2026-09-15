import type { AppointmentStatus } from "../../generated/prisma/client.ts";
import { injected } from "../../prisma/injected.ts";
import { withTenant, type TransactionClient } from "../../prisma/with-tenant.ts";
import type { CallerContext } from "../appointments/appointments.service.ts";
import { lapseOpenRequests } from "../transfers/transfers.service.ts";
import { creditAbandonedPrePayments } from "../billing/patient-credit.ts";
import { transition, type AppointmentEvent } from "../appointments/domain/transition.ts";
import { graceReferenceInstant } from "./domain/no-show.ts";
import { doctorIdForMembership } from "../clinical/clinical.access.ts";
import { doctorFreeAt } from "./queue.readiness.ts";
import type { RefusalParams } from "../../common/refusals.ts";
import type { QueueMoveInput, QueueMoveResult, QueueRefusalReason } from "./queue.types.ts";

/** The refused half of a move. `applyEvent` never returns the other one, and the caller narrows. */
type QueueRefusal = Extract<QueueMoveResult, { ok: false }>;

/**
 * The queue's state changes. Reads live in `queue.queries.ts`; the contracts in `queue.types.ts`.
 *
 * Every function here is a mutation, and every one of them takes an `expectedStatus` — see
 * `queue.service.ts` for why compare-and-set is load-bearing rather than defensive.
 */

/**
 * Reads one appointment and checks the caller's expectation against it.
 *
 * Returns the row so callers do not fetch twice, and a refusal that already carries who moved it.
 */
async function claimRow(
  tx: TransactionClient,
  input: QueueMoveInput,
): Promise<
  | { ok: true; row: { id: string; status: AppointmentStatus; scheduledStart: Date; doctorId: string } }
  | { ok: false; refusal: QueueMoveResult }
> {
  // `FOR UPDATE`, and it is load-bearing rather than defensive.
  //
  // A plain read followed by a write is not a compare-and-set. Under Postgres's default READ
  // COMMITTED, two transactions both read `BOOKED`, both find the expectation satisfied, and both
  // write — two winners, no error, and the second silently overwrites the first's timestamps.
  // Observed: the checkpoint-3 spec produced two `ok: true` results for one appointment under
  // full-suite load, having passed three consecutive runs in isolation.
  //
  // Locking the row makes the read-modify-write serial. The second transaction blocks until the
  // first commits, then sees the *committed* status and refuses with QUEUE_MOVED_ON — which is the
  // outcome Q2 describes and what the caller needs in order to say what actually happened.
  //
  // Raw because Prisma has no `FOR UPDATE`. RLS still applies: this runs on the app role inside
  // withTenant, so another tenant's id selects zero rows exactly as `findFirst` did, and the 404
  // stays indistinguishable from an id that never existed.
  const locked = await tx.$queryRaw<
    { id: string; status: AppointmentStatus; scheduled_start: Date; doctor_id: string }[]
  >`
    SELECT id, status, scheduled_start, doctor_id
      FROM appointments
     WHERE id = ${input.appointmentId}::uuid
       FOR UPDATE
  `;

  const found = locked[0];
  const row =
    found === undefined
      ? null
      : {
          id: found.id,
          status: found.status,
          scheduledStart: found.scheduled_start,
          doctorId: found.doctor_id,
        };

  // 404, not 403 — a cross-tenant id must be indistinguishable from one that never existed.
  if (row === null) {
    return {
      ok: false,
      refusal: { ok: false, code: "NOT_FOUND", params: { resource: "appointment" } },
    };
  }

  if (row.status !== input.expectedStatus) {
    // Who moved it, from the append-only history, so the caller can name them.
    const last = await tx.appointmentEvent.findFirst({
      where: { appointmentId: row.id, eventType: "STATUS_CHANGED" },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { actorUserId: true },
    });

    return {
      ok: false,
      refusal: {
        ok: false,
        code: "QUEUE_MOVED_ON",
        params: { status: row.status, expected: input.expectedStatus },
        currentStatus: row.status,
        movedBy: last?.actorUserId ?? null,
      },
    };
  }

  return { ok: true, row };
}

/** The columns a transition stamps. Kept as data so a new edge cannot forget its timestamp. */
const TIMESTAMP_OF: Partial<Record<AppointmentEvent, "arrivedAt" | "waitingStartedAt" | "consultationStartedAt" | "consultationEndedAt">> = {
  ARRIVE: "arrivedAt",
  MARK_WAITING: "waitingStartedAt",
  START_CONSULTATION: "consultationStartedAt",
  COMPLETE: "consultationEndedAt",
};

/**
 * Applies one event to one row, inside a transaction the caller owns.
 *
 * Writes the status, its timestamp, and the `appointment_events` row together — history is not
 * optional, and a status change without one is a record we cannot explain later.
 */
async function applyEvent(
  tx: TransactionClient,
  caller: CallerContext,
  row: { id: string; status: AppointmentStatus },
  event: AppointmentEvent,
  // Non-optional here even though `transition()` defaults it: every queue event needs at least
  // `now`, and a missing context would silently skip the grace check on MARK_NO_SHOW.
  context: NonNullable<Parameters<typeof transition>[2]> & { now: Date },
): Promise<
  { ok: true; status: AppointmentStatus } | { ok: false; refusal: QueueRefusal }
> {
  const decision = transition(row.status, event, context);
  if (!decision.ok) {
    return {
      ok: false,
      refusal: { ok: false, code: decision.code, params: decision.params },
    };
  }

  const stamp = TIMESTAMP_OF[event];
  await tx.appointment.update({
    where: { id: row.id },
    data: {
      status: decision.next,
      updatedBy: caller.actor.userId,
      ...(stamp === undefined ? {} : { [stamp]: context.now }),
    },
  });

  await tx.appointmentEvent.create({
    data: injected({
      appointmentId: row.id,
      eventType: "STATUS_CHANGED",
      fromStatus: row.status,
      toStatus: decision.next,
      reason: context.reason ?? null,
      actorUserId: caller.actor.userId,
    }),
  });

  // Hooked here rather than in each mover, because this is the single choke point every queue
  // transition passes through -- a future terminal event gets the behaviour without anyone
  // remembering to add it. No-ops unless the new status actually closes a request (D24), and runs
  // in this transaction, not a job: an appointment that ends and a request that closes must commit
  // together or the desk sees a request waiting on a patient who has gone home.
  await lapseOpenRequests(tx, caller.actor.userId, row.id, decision.next, context.now);

  // R-A, hooked at the same choke point and for the same reason: a patient marked no-show who had
  // pre-paid is owed that money, and the credit must commit with the status, not after it.
  await creditAbandonedPrePayments(tx, caller.actor.userId, row.id, decision.next);

  return { ok: true, status: decision.next };
}

/**
 * Check a patient in — `ARRIVE` **and** `MARK_WAITING`, one action (Q6).
 *
 * Two buttons for one human event fails a gate measured in ten minutes to competence. The
 * distinction survives in the data: `arrived_at` and `waiting_started_at` are separate columns and
 * both are written, so a clinic that later wants a distinct arrival desk loses nothing.
 *
 * Both events are applied in **one transaction**. A check-in that left a patient `ARRIVED` but not
 * `WAITING` because the second write failed would put them in a state the queue does not render.
 */
export async function checkIn(caller: CallerContext, input: QueueMoveInput): Promise<QueueMoveResult> {
  return withTenant(caller.tenantId, caller.actor, async (tx) => {
    const claimed = await claimRow(tx, input);
    if (!claimed.ok) return claimed.refusal;

    const arrived = await applyEvent(tx, caller, claimed.row, "ARRIVE", { now: input.now });
    if (!arrived.ok) return arrived.refusal;

    const waiting = await applyEvent(
      tx,
      caller,
      { id: claimed.row.id, status: arrived.status },
      "MARK_WAITING",
      { now: input.now },
    );
    if (!waiting.ok) return waiting.refusal;

    return { ok: true as const, appointmentId: claimed.row.id, status: waiting.status };
  });
}

/**
 * Move an already-arrived patient into the waiting list.
 *
 * `checkIn()` bundles this with `ARRIVE` (Q6), which is what reception uses and what the endpoint
 * table in §6 exposes. This exists separately because the state machine has the edge and a clinic
 * with a distinct arrival desk would need exactly it — and because bundling two writes is a
 * decision about the *screen*, not a reason for the service to be unable to express one of them.
 *
 * It is not a second button. There is no endpoint for it in Phase 3.
 */
export async function markWaiting(
  caller: CallerContext,
  input: QueueMoveInput,
): Promise<QueueMoveResult> {
  return moveOne(caller, input, "MARK_WAITING");
}

/**
 * Start a consultation.
 *
 * **No exclusivity check (Q7).** A doctor with two consultations open at once is allowed and made
 * visible rather than refused: stepping out of one consultation to do a quick dressing change is
 * ordinary in a real clinic, and refusing it would make a real situation unrepresentable to keep
 * the implementation tidy. The failure this might have caught — reception starting the wrong
 * patient from a stale screen — is Q2's compare-and-set, which is where it belongs, because that
 * is a staleness problem and not a clinical one.
 */
export async function startConsultation(
  caller: CallerContext,
  input: QueueMoveInput,
): Promise<QueueMoveResult> {
  // Q40: starting a consultation is the appointment's own doctor's act, like pausing and finishing.
  return moveOwn(caller, input, "START_CONSULTATION");
}

/**
 * Pause and resume a consultation — Q34. The patient stepped out for imaging or a lab.
 *
 * **The doctor's own act about their own consultation.** `visits.write` is DOCTOR-only, which keeps
 * reception out; this second check keeps a colleague out, because "the patient stepped out" is a
 * fact only the doctor they stepped out on can state. The draft is untouched — it stays open and
 * stays private to its author (Q2), and PAUSED counts as present for that doctor
 * (`clinical.access.ts`), which is what stops the record closing underneath them.
 *
 * The reason is optional and lands on the `appointment_events` row, not on the queue: it is written
 * by a clinician, and Q14's line puts anything clinician-authored off reception's board.
 */
export async function pauseConsultation(
  caller: CallerContext,
  input: QueueMoveInput,
): Promise<QueueMoveResult> {
  return moveOwn(caller, input, "PAUSE");
}

export async function resumeConsultation(
  caller: CallerContext,
  input: QueueMoveInput,
): Promise<QueueMoveResult> {
  return moveOwn(caller, input, "RESUME");
}

/** `moveOne`, plus the appointment being the caller's own. */
async function moveOwn(
  caller: CallerContext,
  input: QueueMoveInput,
  event: AppointmentEvent,
): Promise<QueueMoveResult> {
  return withTenant(caller.tenantId, caller.actor, async (tx) => {
    const claimed = await claimRow(tx, input);
    if (!claimed.ok) return claimed.refusal;

    const callerDoctorId = await doctorIdForMembership(tx, caller.membershipId);
    if (callerDoctorId === null || callerDoctorId !== claimed.row.doctorId) {
      return { ok: false as const, code: "NOT_PERMITTED" as const, params: {} };
    }

    const applied = await applyEvent(tx, caller, claimed.row, event, {
      now: input.now,
      reason: input.reason ?? null,
    });
    if (!applied.ok) return applied.refusal;

    return { ok: true as const, appointmentId: claimed.row.id, status: applied.status };
  });
}

export async function completeConsultation(
  caller: CallerContext,
  input: QueueMoveInput,
): Promise<QueueMoveResult> {
  return moveOwn(caller, input, "COMPLETE");
}

/**
 * Mark a patient absent. **A human action only** — see `pendingNoShows()`.
 *
 * The grace period is enforced inside `transition()`, measured from the readiness instant (Q9):
 * the later of the appointment's start and the moment that doctor last became free.
 */
export async function markNoShow(
  caller: CallerContext,
  input: QueueMoveInput,
): Promise<QueueMoveResult> {
  return withTenant(caller.tenantId, caller.actor, async (tx) => {
    const claimed = await claimRow(tx, input);
    if (!claimed.ok) return claimed.refusal;

    const tenant = await tx.tenant.findUnique({
      where: { id: caller.tenantId },
      select: { noShowGraceMinutes: true },
    });

    const applied = await applyEvent(tx, caller, claimed.row, "MARK_NO_SHOW", {
      now: input.now,
      scheduledStart: claimed.row.scheduledStart,
      graceReference: graceReferenceInstant(
        claimed.row.scheduledStart,
        await doctorFreeAt(tx, claimed.row.doctorId, input.now),
      ),
      noShowGraceMinutes: tenant?.noShowGraceMinutes ?? 30,
    });
    if (!applied.ok) return applied.refusal;

    return { ok: true as const, appointmentId: claimed.row.id, status: applied.status };
  });
}

/** One row, one event — the shape every queue move except check-in and no-show shares. */
async function moveOne(
  caller: CallerContext,
  input: QueueMoveInput,
  event: AppointmentEvent,
): Promise<QueueMoveResult> {
  return withTenant(caller.tenantId, caller.actor, async (tx) => {
    const claimed = await claimRow(tx, input);
    if (!claimed.ok) return claimed.refusal;

    const applied = await applyEvent(tx, caller, claimed.row, event, {
      now: input.now,
      reason: input.reason ?? null,
    });
    if (!applied.ok) return applied.refusal;

    return { ok: true as const, appointmentId: claimed.row.id, status: applied.status };
  });
}

/**
 * Complete an appointment from inside a caller's own transaction — the visit screen's end-visit
 * button (Q26), which is Q6's completion trigger and not a second act that could disagree with it.
 *
 * Walks the legal edges rather than jumping: a doctor who never pressed "start" on the queue still
 * consulted, so ARRIVED and WAITING are carried through `MARK_WAITING`/`START_CONSULTATION` first,
 * each writing its own `appointment_events` row. Bundling edges for one human act is the same
 * decision `checkIn` already makes. An appointment somebody else already completed is a no-op.
 */
export async function completeAppointmentInTx(
  tx: TransactionClient,
  caller: CallerContext,
  appointmentId: string,
  now: Date,
): Promise<
  { ok: true; status: AppointmentStatus } | { ok: false; code: QueueRefusalReason; params: RefusalParams }
> {
  const row = await tx.appointment.findFirst({
    where: { id: appointmentId },
    select: { id: true, status: true },
  });
  if (row === null) {
    return { ok: false, code: "NOT_FOUND", params: { resource: "appointment" } };
  }
  if (row.status === "COMPLETED") return { ok: true, status: "COMPLETED" };

  const path: Partial<Record<AppointmentStatus, readonly AppointmentEvent[]>> = {
    ARRIVED: ["MARK_WAITING", "START_CONSULTATION", "COMPLETE"],
    WAITING: ["START_CONSULTATION", "COMPLETE"],
    IN_CONSULTATION: ["COMPLETE"],
  };

  let current: AppointmentStatus = row.status;
  for (const event of path[current] ?? ["COMPLETE"]) {
    const applied = await applyEvent(tx, caller, { id: row.id, status: current }, event, { now });
    if (!applied.ok) {
      return { ok: false, code: applied.refusal.code, params: applied.refusal.params };
    }
    current = applied.status;
  }
  return { ok: true, status: current };
}
