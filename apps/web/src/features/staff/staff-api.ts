// «المستخدمون» — Phase 5 PR 10. Accounts and access, never employment.

type AuthFetch = (path: string, init?: RequestInit) => Promise<Response>;

export const STAFF_ROLES = ["RECEPTIONIST", "ADMIN"] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];

export interface StaffMember {
  membershipId: string;
  userId: string;
  fullName: string;
  phoneE164: string;
  role: string;
  status: string;
  /** ISO instant, or null for somebody who has never signed in. */
  lastLoginAt: string | null;
  mustChangePassword: boolean;
  /** False for a doctor: their record belongs to the Doctors tab, and this row links across. */
  editableHere: boolean;
  doctorId: string | null;
  /** Whether a photo is stored, so a row with none draws initials instead of asking for a 404. */
  hasPhoto: boolean;
}

type Refused = { ok: false; code: string; params: Record<string, unknown> };

async function refusal(response: Response): Promise<Refused> {
  const body: unknown = await response.json().catch(() => null);
  const shape = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  return {
    ok: false,
    code: typeof shape["code"] === "string" ? (shape["code"] as string) : "INTERNAL",
    params: (shape["params"] as Record<string, unknown>) ?? {},
  };
}

export async function loadStaff(authFetch: AuthFetch): Promise<StaffMember[]> {
  const response = await authFetch("/api/staff");
  if (!response.ok) return [];
  const body: unknown = await response.json();
  return Array.isArray(body) ? (body as StaffMember[]) : [];
}

/**
 * The temporary password comes back **here and nowhere else**.
 *
 * It is empty when the person already had an account in another clinic: they keep the password they
 * already use, and printing a credential that does not work would be worse than saying so.
 */
export async function createStaff(
  authFetch: AuthFetch,
  input: { fullName: string; phone: string; role: StaffRole },
): Promise<{ ok: true; member: StaffMember; temporaryPassword: string } | Refused> {
  const response = await authFetch("/api/staff", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!response.ok) return refusal(response);
  const body = (await response.json()) as { member: StaffMember; temporaryPassword: string };
  return { ok: true, ...body };
}

/**
 * Edits a user: whichever of the three fields changed.
 *
 * Only the changed fields are sent, so an unchanged phone is never re-submitted — the server treats
 * a person's own number as theirs, but sending less also means fewer things to be refused over.
 */
export async function updateStaff(
  authFetch: AuthFetch,
  membershipId: string,
  input: { fullName?: string; phone?: string; role?: StaffRole },
): Promise<{ ok: true; member: StaffMember } | Refused> {
  const response = await authFetch(`/api/staff/${membershipId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!response.ok) return refusal(response);
  return { ok: true, member: (await response.json()) as StaffMember };
}

/**
 * The profile photo: upload, read, and stop using.
 *
 * Multipart, and the route sniffs the bytes — so `accept` on the input is a convenience and never
 * the check. "Remove" clears the pointer; the stored file is not destroyed.
 */
export async function uploadUserPhoto(
  authFetch: AuthFetch,
  membershipId: string,
  file: File,
): Promise<boolean> {
  const form = new FormData();
  form.append("file", file);
  const response = await authFetch(`/api/staff/${membershipId}/photo`, { method: "POST", body: form });
  return response.ok;
}

export async function loadUserPhoto(authFetch: AuthFetch, membershipId: string): Promise<string | null> {
  const response = await authFetch(`/api/staff/${membershipId}/photo`);
  if (!response.ok) return null;
  return URL.createObjectURL(await response.blob());
}

export async function removeUserPhoto(authFetch: AuthFetch, membershipId: string): Promise<boolean> {
  return (await authFetch(`/api/staff/${membershipId}/photo`, { method: "DELETE" })).ok;
}

/**
 * Your own name and phone. The membership comes from the token, so there is no id to pass — and
 * deliberately no role to send.
 */
export async function updateMyDetails(
  authFetch: AuthFetch,
  input: { fullName?: string; phone?: string },
): Promise<{ ok: true; member: StaffMember } | Refused> {
  const response = await authFetch("/api/staff/me", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!response.ok) return refusal(response);
  return { ok: true, member: (await response.json()) as StaffMember };
}

/**
 * Your own photo. A separate pair of routes because they need no authority over anyone else's
 * account — literal paths, one function each, the way the rest of this file is written.
 */
export async function uploadMyPhoto(authFetch: AuthFetch, file: File): Promise<boolean> {
  const form = new FormData();
  form.append("file", file);
  return (await authFetch("/api/staff/me/photo", { method: "POST", body: form })).ok;
}

export async function removeMyPhoto(authFetch: AuthFetch): Promise<boolean> {
  return (await authFetch("/api/staff/me/photo", { method: "DELETE" })).ok;
}

export async function setStaffStatus(
  authFetch: AuthFetch,
  membershipId: string,
  status: "ACTIVE" | "SUSPENDED",
): Promise<{ ok: true; member: StaffMember } | Refused> {
  const response = await authFetch(`/api/staff/${membershipId}/status`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status }),
  });
  if (!response.ok) return refusal(response);
  return { ok: true, member: (await response.json()) as StaffMember };
}

export async function resetStaffPassword(
  authFetch: AuthFetch,
  membershipId: string,
): Promise<{ ok: true; temporaryPassword: string } | Refused> {
  const response = await authFetch(`/api/staff/${membershipId}/password`, { method: "POST" });
  if (!response.ok) return refusal(response);
  return { ok: true, ...((await response.json()) as { temporaryPassword: string }) };
}

/** Replaces a temporary password. The only route that works while one is outstanding. */
export async function changePassword(
  authFetch: AuthFetch,
  input: { currentPassword: string; newPassword: string },
): Promise<{ ok: true; accessToken: string } | Refused> {
  const response = await authFetch("/api/auth/password", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!response.ok) return refusal(response);
  return { ok: true, ...((await response.json()) as { accessToken: string }) };
}
