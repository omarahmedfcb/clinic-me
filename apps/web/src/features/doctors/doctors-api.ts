/**
 * The doctors screen's view of the API. Types only, plus thin fetch wrappers.
 *
 * Mirrors `apps/api/src/modules/doctors/` — CLAUDE.md's rule that modules mirror between the two
 * trees. Hand-written rather than shared through a package, the same choice services and schedules
 * made.
 *
 * ## `futureAppointmentCount` is the deactivation warning
 *
 * Appointments still to happen that are booked with this doctor. Deactivation does nothing to them:
 * they stay on the board and somebody has to move them, which is precisely why the number is shown
 * before the admin confirms. It informs, it never blocks — the same ruling services follow, and for
 * a stronger reason. A service nobody can book still gets performed; a doctor taken off the board
 * has appointments with no one to see them.
 *
 * ## `createDoctor` creates the person too
 *
 * It takes a name and a phone number, so a doctor no longer has to be picked from existing staff.
 * Room number and licence expiry are not on the create route; a new doctor is opened afterwards for them.
 */

export interface Doctor {
  id: string;
  membershipId: string;
  fullName: string;
  title: string;
  specialty: string;
  licenseNumber: string;
  /** `YYYY-MM-DD`, or null when nobody has recorded it. A calendar day, never an instant. */
  licenseExpiry: string | null;
  roomNumber: string | null;
  /** What a printed sheet says about this doctor — Q28's fields, on the doctor's record since Q38. */
  printedName: string | null;
  /** Whether a profile photo is stored. The avatar draws initials when it is false. */
  hasPhoto: boolean;
  /** Q45: what the English sheet prints under the signature. */
  printedNameEn: string | null;
  syndicateNumber: string | null;
  /** R1 and R2, set by an admin on the doctor form. */
  mayAdjustPrices: boolean;
  /** The cap on that permission. Null means unlimited; the lower of the two binds. */
  priceAdjustmentCapPercent: number | null;
  priceAdjustmentCapMinor: number | null;
  collectsPayments: boolean;
  hasSignature: boolean;
  hasStamp: boolean;
  isActive: boolean;
  futureAppointmentCount: number;
}

type AuthFetch = (path: string, init?: RequestInit) => Promise<Response>;

export async function loadDoctors(authFetch: AuthFetch): Promise<Doctor[]> {
  const response = await authFetch("/api/doctors");
  if (!response.ok) throw new Error(`GET /doctors -> ${response.status}`);
  return (await response.json()) as Doctor[];
}

/**
 * A rejection is returned rather than thrown, the same shape services and the schedule editor use:
 * the API answers with a message naming what it refused, and that is more use to an admin than
 * "save failed".
 */
export type WriteResult = { ok: true; doctor: Doctor } | { ok: false; message: string };

/**
 * Deactivation and reactivation are the same call, because on the server they are the same write.
 *
 * There is deliberately no `deleteDoctor`: a doctor row is referenced by appointments, visits and
 * prescriptions, `ON DELETE RESTRICT` would refuse the delete, and CLAUDE.md forbids hard-deleting
 * medical records regardless. A client function that cannot exist should not be declared.
 */
export async function setDoctorActive(
  authFetch: AuthFetch,
  id: string,
  isActive: boolean,
): Promise<WriteResult> {
  const response = await authFetch(`/api/doctors/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ isActive }),
  });

  if (response.ok) return { ok: true, doctor: (await response.json()) as Doctor };
  return { ok: false, message: await refusalMessage(response, `PATCH /doctors/${id}`) };
}

/**
 * Adding a doctor creates the person, their login and the record in one call. The temporary password
 * comes back **here and nowhere else**; it is empty when the phone already had an account elsewhere.
 * A refusal carries the server's `code` and `params` so the dialog can say it in the clinic's language.
 */
export type CreateResult =
  | { ok: true; doctor: Doctor; temporaryPassword: string }
  | { ok: false; message: string; code: string | null; params: Record<string, unknown> };

export async function createDoctor(
  authFetch: AuthFetch,
  input: { fullName: string; phone: string; title: string; specialty: string; licenseNumber: string },
): Promise<CreateResult> {
  const response = await authFetch("/api/doctors", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });

  if (response.ok) {
    const body = (await response.json()) as { doctor: Doctor; temporaryPassword: string };
    return { ok: true, doctor: body.doctor, temporaryPassword: body.temporaryPassword };
  }
  const body = (await response.clone().json().catch(() => null)) as { code?: unknown; params?: unknown } | null;
  return {
    ok: false,
    message: await refusalMessage(response, "POST /doctors"),
    code: typeof body?.code === "string" ? body.code : null,
    params: typeof body?.params === "object" && body.params !== null ? (body.params as Record<string, unknown>) : {},
  };
}

/**
 * Editing a doctor's details. Every field optional, because the route is a PATCH.
 *
 * `null` is a value here and is deliberately not the same as omitting the field: omitting leaves
 * what is stored alone, and `null` says the recorded value was wrong and should go. A form that
 * could only ever set is one an admin cannot use to undo a typo — which is why `licenseExpiry` and
 * `roomNumber` are typed `string | null | undefined` rather than `string | undefined`, and why
 * clearing the input sends `null` instead of dropping the key.
 *
 * `isActive` is reachable from here too, but the list keeps using `setDoctorActive` below: the
 * deactivation flow has a warning attached to it and a second path into the same write would be a
 * second place for that warning to be forgotten.
 */
export async function updateDoctor(
  authFetch: AuthFetch,
  id: string,
  input: {
    title?: string;
    specialty?: string;
    licenseNumber?: string;
    licenseExpiry?: string | null;
    roomNumber?: string | null;
    printedName?: string | null;
    printedNameEn?: string | null;
    syndicateNumber?: string | null;
    mayAdjustPrices?: boolean;
    priceAdjustmentCapPercent?: number | null;
    priceAdjustmentCapMinor?: number | null;
    collectsPayments?: boolean;
  },
): Promise<WriteResult> {
  const response = await authFetch(`/api/doctors/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });

  if (response.ok) return { ok: true, doctor: (await response.json()) as Doctor };
  return { ok: false, message: await refusalMessage(response, `PATCH /doctors/${id}`) };
}

/**
 * The refusal the server wrote, or the status if it wrote none.
 *
 * Extracted rather than repeated a third time. `class-validator` returns `message` as an array when
 * several fields fail at once, and a screen that renders `[object Object]` at that moment is one
 * that fails exactly when it has the most to say.
 */
async function refusalMessage(response: Response, route: string): Promise<string> {
  const body = (await response.json().catch(() => null)) as { message?: string | string[] } | null;
  const message = Array.isArray(body?.message) ? body.message.join(", ") : body?.message;
  return message ?? `${route} -> ${response.status}`;
}
