import type { AppointmentStatus } from "../../domain/appointment-status.ts";

/**
 * The queue's requests — `PHASE-3.md` §6.
 *
 * One request paints the whole board (`GET /queue/today`), for the same reason the week grid is one
 * request rather than seven: several requests are several snapshots, and a queue that disagrees
 * with itself between two of them is a bug that only appears on a busy morning.
 *
 * ## Every mutation carries `expectedStatus`
 *
 * That is Q2's compare-and-set, and this file is where the screen's idea of the row is turned into
 * a claim the server can refuse. The status sent is **the one this screen is currently showing** —
 * never one recomputed at click time — because the entire point is to detect that the screen was
 * out of date.
 */

/**
 * Enough to decide about money at the desk, and deliberately nothing more — the policy number and
 * the validity dates live on the profile.
 *
 * **Three states, not a boolean.** "Cover lapsed" and "cash patient" are different conversations to
 * have with the person standing at the desk, and this is the moment reception has them. A boolean
 * would delete that distinction exactly where it is needed.
 *
 * It arrives **on the queue row**, in the same response as everything else. The board polls every
 * five seconds, so a per-row lookup would multiply the whole screen's cost by the number of patients
 * waiting, permanently, to render one label.
 */
export type QueueCoverage =
  | { standing: "COVERED"; insurerName: string }
  | { standing: "LAPSED"; insurerName: string }
  | { standing: "NONE" };

export interface QueueEntry {
  appointmentId: string;
  patientId: string;
  patientName: string | null;
  coverage: QueueCoverage;
  doctorId: string;
  serviceId: string;
  status: AppointmentStatus;
  scheduledStart: string;
  scheduledEnd: string;
  arrivedAt: string | null;
  waitingStartedAt: string | null;
  consultationStartedAt: string | null;
  /** Milliseconds since arrival, computed by the server against its own clock. */
  waitedMs: number | null;
  isWalkIn: boolean;
  /**
   * DRAFT while the doctor is writing, COMPLETED once finished, null when no visit exists — Q14.
   *
   * The status, and nothing about its content. Reception needs it because a patient whose visit is
   * in progress must not be checked in again, and the board has to be able to say why someone is
   * neither waiting nor finished.
   */
  visitStatus: "DRAFT" | "COMPLETED" | null;
}

export interface NoShowCandidate {
  appointmentId: string;
  patientId: string;
  patientName: string | null;
  doctorId: string;
  scheduledStart: string;
  eligibleSince: string;
}

export type QueueMove = "check-in" | "start" | "pause" | "resume" | "complete" | "no-show";

/**
 * A refusal, already reduced to what the screen needs to say something human.
 *
 * `movedBy` is a user id rather than a name; the page resolves it against the doctors it already
 * loaded. When it cannot — a receptionist moved it, or the id is unknown — the message says
 * somebody moved it rather than inventing a name.
 */
export interface QueueRefusal {
  kind: "moved-on" | "refused" | "gone" | "error";
  currentStatus?: AppointmentStatus;
  movedBy?: string | null;
}

export type MoveOutcome = { ok: true } | { ok: false; refusal: QueueRefusal };

type AuthFetch = (path: string, init?: RequestInit) => Promise<Response>;

export async function loadQueue(
  authFetch: AuthFetch,
  date: string,
): Promise<{ date: string; entries: QueueEntry[] }> {
  const response = await authFetch(`/api/queue/today?date=${date}`);
  if (!response.ok) throw new Error(`GET /queue/today -> ${response.status}`);
  return (await response.json()) as { date: string; entries: QueueEntry[] };
}

export async function loadNoShowCandidates(
  authFetch: AuthFetch,
  date: string,
): Promise<NoShowCandidate[]> {
  const response = await authFetch(`/api/no-shows/pending?date=${date}`);
  if (!response.ok) throw new Error(`GET /no-shows/pending -> ${response.status}`);
  const body = (await response.json()) as { candidates: NoShowCandidate[] };
  return body.candidates;
}

/**
 * Applies one move, and turns a refusal into something the page can put into words.
 *
 * The three outcomes are deliberately distinct rather than collapsed into "failed":
 *
 * - **409 `QUEUE_MOVED_ON`** — somebody else moved this patient. Recoverable and ordinary; the
 *   screen refreshes and the receptionist sees the new state.
 * - **409 anything else** — the move is impossible for this row now (already completed, grace not
 *   elapsed). Also recoverable, but nobody else caused it.
 * - **404** — the row is gone from this clinic's view entirely.
 */
export async function moveQueue(
  authFetch: AuthFetch,
  appointmentId: string,
  move: QueueMove,
  expectedStatus: AppointmentStatus,
): Promise<MoveOutcome> {
  const response = await authFetch(`/api/queue/${appointmentId}/${move}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ expectedStatus }),
  });

  if (response.ok) return { ok: true };

  if (response.status === 404) return { ok: false, refusal: { kind: "gone" } };

  if (response.status === 409) {
    const body = (await response.json().catch(() => ({}))) as {
      reason?: string;
      currentStatus?: AppointmentStatus;
      movedBy?: string | null;
    };
    if (body.reason === "QUEUE_MOVED_ON") {
      return {
        ok: false,
        refusal: {
          kind: "moved-on",
          ...(body.currentStatus === undefined ? {} : { currentStatus: body.currentStatus }),
          ...(body.movedBy === undefined ? {} : { movedBy: body.movedBy }),
        },
      };
    }
    return {
      ok: false,
      refusal: {
        kind: "refused",
        ...(body.currentStatus === undefined ? {} : { currentStatus: body.currentStatus }),
      },
    };
  }

  return { ok: false, refusal: { kind: "error" } };
}
