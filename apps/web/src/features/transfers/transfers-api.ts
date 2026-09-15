/**
 * The transfers API client. `PHASE-3.md` Q16/Q17/Q21, `SCHEMA-DECISIONS.md` D24.
 *
 * One `GET` serves all three surfaces — reception, the originating doctor and the receiving doctor
 * — because the server scopes it by role. Three endpoints would be three chances for the screens to
 * disagree about one request.
 */

/**
 * `authFetch` does **not** add the `/api` prefix — every caller writes it, and this file did not.
 *
 * The failure that caused is worth recording, because it is invisible to the obvious guard: the dev
 * server answered `/transfers` with its SPA fallback, so the response was **200 with `index.html`**.
 * `response.ok` is true for that, so `if (!response.ok) throw` passes, and the error surfaced much
 * later as `Unexpected token '<' ... is not valid JSON` inside a `catch` that rendered a blank
 * "failed to load" panel with nothing in the console. A wrong path does not look like a wrong path;
 * it looks like a broken screen.
 */
type AuthFetch = (path: string, init?: RequestInit) => Promise<Response>;

export type TransferStatus = "PENDING" | "ACCEPTED" | "REJECTED" | "LAPSED";

export interface Transfer {
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
  requestedAt: string;
  decidedAt: string | null;
}

/** A refusal the screen must render as a sentence, not a status code. */
export interface TransferRefusal {
  reason: string;
  message: string;
}

export type TransferOutcome = { ok: true; transfer: Transfer } | { ok: false; refusal: TransferRefusal };

async function refusalOf(response: Response): Promise<TransferRefusal> {
  try {
    const body = (await response.json()) as { reason?: string; message?: string };
    return {
      reason: body.reason ?? "UNKNOWN",
      // A refusal with no sentence is worse than none: the desk sees a red box and no instruction.
      message: body.message ?? "تعذّر تنفيذ الطلب.",
    };
  } catch {
    return { reason: "UNKNOWN", message: "تعذّر تنفيذ الطلب." };
  }
}

export async function loadTransfers(authFetch: AuthFetch, openOnly = true): Promise<Transfer[]> {
  const response = await authFetch(`/api/transfers?openOnly=${openOnly ? "true" : "false"}`);
  if (!response.ok) throw new Error(`transfers: ${response.status}`);
  return ((await response.json()) as { transfers: Transfer[] }).transfers;
}

export async function requestTransfer(
  authFetch: AuthFetch,
  input: { appointmentId: string; toDoctorId: string; reason: string },
): Promise<TransferOutcome> {
  const response = await authFetch("/api/transfers", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      appointmentId: input.appointmentId,
      toDoctorId: input.toDoctorId,
      // Omitted rather than sent empty: the DTO rejects unknown shapes and an empty reason is
      // "no reason given", which is a different thing from an empty string.
      ...(input.reason.trim().length === 0 ? {} : { reason: input.reason.trim() }),
    }),
  });
  if (!response.ok) return { ok: false, refusal: await refusalOf(response) };
  return { ok: true, transfer: (await response.json()) as Transfer };
}

export async function decideTransfer(
  authFetch: AuthFetch,
  id: string,
  decision: "accept" | "reject",
  decisionNote: string,
): Promise<TransferOutcome> {
  const response = await authFetch(`/api/transfers/${id}/${decision}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(decisionNote.trim().length === 0 ? {} : { decisionNote: decisionNote.trim() }),
  });
  if (!response.ok) return { ok: false, refusal: await refusalOf(response) };
  return { ok: true, transfer: (await response.json()) as Transfer };
}

/**
 * How long a request has been waiting, in whole minutes.
 *
 * **`now` is a parameter**, not `Date.now()` read inside. The elapsed time is the only thing making
 * a request with no timeout actionable — the founder's ruling was that reception can walk over,
 * which only works if they can see how long it has sat — so it is worth being able to test at a
 * fixed instant rather than approximately.
 */
export function waitedMinutes(requestedAt: string, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - Date.parse(requestedAt)) / 60_000));
}
