// The platform console's view of the API — pilot-readiness 0b–0f, plus the back office of
// 2026-09-15. Its own login and its own token: the operator holds no membership, so nothing here
// goes through the clinic session.

export interface PlanLine {
  doctors: number;
  monthlyMinor: number;
  includedMessages: number;
  setupMinor: number;
}

export interface Clinic {
  tenantId: string;
  name: string;
  slug: string;
  country: string;
  currency: string;
  timezone: string;
  status: string;
  suspensionReason: string | null;
  createdAt: string;
  lastActivity: string | null;
  patients: number;
  doctors: number;
  staff: number;
  appointmentsThisMonth: number;
  plan: PlanLine;
  /**
   * Who a temporary password may be issued to — ADMIN and OWNER only.
   *
   * A doctor is not in this list, because the server's own function does not return one: their login
   * is the one that reaches clinical content. So the screen offers no button that would be refused.
   */
  admins: { userId: string; fullName: string; role: string }[];
  /** TRIAL | ACTIVE | OVERDUE | SUSPENDED — the commercial state, not `status`. */
  accountStatus: string;
  renewalOn: string | null;
  renewalInDays: number | null;
  /** Inside the fourteen-day window, or already past it. Computed on the server. */
  renewalDue: boolean;
}

export interface NewClinicInput {
  name: string;
  slug: string;
  timezone: string;
  /** ISO 3166-1 alpha-2. The clinic's own phone-parsing hint (ARCHITECTURE.md §18b). */
  country: "EG" | "SA" | "AE";
  currency: string;
  address: string;
  phone: string;
  adminFullName: string;
  adminPhone: string;
}

export interface Operator {
  userId: string;
  fullName: string;
  phoneE164: string;
  platformRole: string;
  status: string;
  totpEnrolled: boolean;
  createdAt: string;
}

export interface ClientFile {
  tenantId: string;
  salesOwnerUserId: string | null;
  salesOwnerName: string | null;
  agreedPlan: string | null;
  agreedMonthlyMinor: number | null;
  discountPercent: number | null;
  accountStatus: string;
  trialEndsOn: string | null;
  renewalOn: string | null;
  notes: string | null;
  contacts: { id: string; fullName: string; role: string | null; phoneE164: string | null; email: string | null }[];
  contracts: { id: string; fileName: string; sizeBytes: number; startsOn: string; endsOn: string; uploadedAt: string }[];
}

export type Refused = { ok: false; code: string; params: Record<string, unknown> };

/**
 * Turns a refused response into a code the console can render a sentence for.
 *
 * `INTERNAL` is the **last** resort and, since 2026-09-15, genuinely rare: the server's validation
 * pipe now attaches `INVALID_FIELD` with the field's name to what used to arrive as a bare
 * `{ message: [...] }`. Before that, a mistyped short name reached the operator as "a system error
 * occurred. Nothing was changed. Tell your system administrator." — the server blamed for a typo.
 */
async function refusal(response: Response): Promise<Refused> {
  const body: unknown = await response.json().catch(() => null);
  const shape = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  return {
    ok: false,
    code: typeof shape["code"] === "string" ? (shape["code"] as string) : "INTERNAL",
    params: (shape["params"] as Record<string, unknown>) ?? {},
  };
}

/**
 * The operator's token lives in memory for the tab's lifetime and is never written to storage.
 *
 * A clinic session persists because a receptionist works a whole day in one; the operator signs in,
 * does one thing and leaves, and a token in `localStorage` on a laptop that also browses the web is
 * a worse trade for the account that can create and suspend clinics.
 */
let token: string | null = null;

export const platformToken = {
  get: (): string | null => token,
  set: (next: string | null): void => {
    token = next;
  },
};

async function send(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`/api${path}`, {
    ...init,
    headers: {
      ...(init?.headers ?? {}),
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      ...(init?.body === undefined || init.body instanceof FormData ? {} : { "content-type": "application/json" }),
    },
  });
}

async function post<T>(path: string, body?: unknown): Promise<({ ok: true } & T) | Refused> {
  const response = await send(path, {
    method: "POST",
    ...(body === undefined ? {} : { body: body instanceof FormData ? body : JSON.stringify(body) }),
  });
  if (!response.ok) return refusal(response);
  const text = await response.text();
  return { ok: true, ...(text === "" ? {} : (JSON.parse(text) as T)) } as { ok: true } & T;
}

// ---------------------------------------------------------------------------------------------
// Signing in: the password, then the second factor. Never one step.
// ---------------------------------------------------------------------------------------------

/** What the password alone buys: a five-minute token that opens the two enrolment routes. */
let pendingToken: string | null = null;

export async function platformLogin(
  identifier: string,
  password: string,
): Promise<{ ok: true; fullName: string; totpEnrolled: boolean; totpRequired: boolean } | Refused> {
  const response = await fetch("/api/platform/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ identifier, password }),
  });
  if (!response.ok) return refusal(response);

  const body = (await response.json()) as {
    pendingToken?: string;
    accessToken?: string;
    fullName: string;
    totpEnrolled: boolean;
    totpRequired: boolean;
  };

  /*
   * `OPERATOR_TOTP=off` — a development and review build. The server has already decided, and it is
   * the only thing that can: the API refuses to boot with that flag when `NODE_ENV=production`, so
   * a screen reading `totpRequired` cannot be talked into skipping the step on a live deployment.
   */
  if (body.totpRequired === false && typeof body.accessToken === "string") {
    token = body.accessToken;
    pendingToken = null;
    return { ok: true, fullName: body.fullName, totpEnrolled: body.totpEnrolled, totpRequired: false };
  }

  pendingToken = body.pendingToken ?? null;
  // Deliberately not set as `token`: it opens nothing, and treating it as a session would put the
  // console into a state where every read fails with a 401 that looks like a bug.
  return { ok: true, fullName: body.fullName, totpEnrolled: body.totpEnrolled, totpRequired: true };
}

async function withPending(path: string, body?: unknown): Promise<Response> {
  return fetch(`/api${path}`, {
    method: "POST",
    headers: {
      ...(pendingToken === null ? {} : { authorization: `Bearer ${pendingToken}` }),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

export async function beginEnrolment(): Promise<{ ok: true; secretBase32: string; otpauthUri: string } | Refused> {
  const response = await withPending("/platform/totp/enrol");
  if (!response.ok) return refusal(response);
  return { ok: true, ...((await response.json()) as { secretBase32: string; otpauthUri: string }) };
}

/** Confirms a new authenticator, or answers the challenge. Both end with a usable token. */
export async function answerSecondFactor(
  totpCode: string,
  what: "confirm" | "verify",
): Promise<{ ok: true; fullName: string; recoveryCodes: string[] | null } | Refused> {
  const response = await withPending(`/platform/totp/${what}`, { totpCode });
  if (!response.ok) return refusal(response);

  const body = (await response.json()) as {
    accessToken: string;
    fullName: string;
    recoveryCodes?: string[];
  };
  token = body.accessToken;
  pendingToken = null;
  // Present only on "confirm": the first set of recovery codes, shown once and never readable again.
  return { ok: true, fullName: body.fullName, recoveryCodes: body.recoveryCodes ?? null };
}

/**
 * Signs in with a recovery code when the authenticator is gone.
 *
 * The session it opens is marked `via: "recovery"` on the server, which is the only session allowed
 * to replace the authenticator — so the console must send the operator there next.
 */
export async function signInWithRecoveryCode(
  recoveryCode: string,
): Promise<{ ok: true; fullName: string; remaining: number } | Refused> {
  const response = await withPending("/platform/totp/recovery", { recoveryCode });
  if (!response.ok) return refusal(response);

  const body = (await response.json()) as {
    accessToken: string;
    fullName: string;
    recoveryCodesRemaining: number;
  };
  token = body.accessToken;
  pendingToken = null;
  return { ok: true, fullName: body.fullName, remaining: body.recoveryCodesRemaining };
}

/** Starts replacing a lost authenticator. Refused outside a recovery session. */
export const beginTotpReplacement = (
  password: string,
): Promise<{ ok: true; secretBase32: string; otpauthUri: string } | Refused> =>
  post("/platform/totp/replace", { password });

/** Proves the new authenticator. Returns reissued codes — the lost device likely held the old file. */
export async function confirmTotpReplacement(
  totpCode: string,
): Promise<{ ok: true; recoveryCodes: string[] } | Refused> {
  const result = await post<{ accessToken: string; recoveryCodes: string[] }>(
    "/platform/totp/replace/confirm",
    { totpCode },
  );
  if (!result.ok) return result;

  // The new token has no `via`, so the session stops being a recovery session here.
  token = result.accessToken;
  return { ok: true, recoveryCodes: result.recoveryCodes };
}

/** Replaces the whole set, for an operator who still holds their authenticator. */
export const regenerateRecoveryCodes = (
  password: string,
  totpCode: string,
): Promise<{ ok: true; recoveryCodes: string[] } | Refused> =>
  post("/platform/recovery-codes/regenerate", { password, totpCode });

/**
 * Which seat the signed-in operator holds.
 *
 * Read from the server rather than carried in the login response: the console shows and hides the
 * OWNER-only controls from it, and `/platform/me` re-reads the row on every request, so a seat
 * revoked a minute ago is reflected here.
 */
export interface Me {
  userId: string;
  fullName: string;
  platformRole: string;
  /** Unused recovery codes. Drives the banner; zero is the state of every operator enrolled before
   *  2026-09-16, for whom "0 left — regenerate" is the path rather than a backfill. */
  recoveryCodesRemaining: number;
  /**
   * "recovery" when a recovery code opened this session.
   *
   * Read from the server rather than remembered in the client, so a reload still knows and still
   * insists on the replacement — the whole point is that it cannot be clicked away.
   */
  via: "recovery" | null;
}

export async function loadMe(): Promise<Me | null> {
  const response = await send("/platform/me");
  if (!response.ok) return null;
  return (await response.json()) as Me;
}

// ---------------------------------------------------------------------------------------------
// Clinics
// ---------------------------------------------------------------------------------------------

/** Throws rather than answering with an empty list: "you operate no clinics" is a claim. */
export async function loadClinics(): Promise<Clinic[]> {
  const response = await send("/platform/clinics");
  if (!response.ok) throw new Error(`GET /platform/clinics -> ${response.status}`);
  const body = (await response.json()) as { clinics?: Clinic[] };
  if (!Array.isArray(body.clinics)) throw new Error("GET /platform/clinics -> unreadable payload");
  return body.clinics;
}

export const createClinic = (
  input: NewClinicInput,
): Promise<{ ok: true; tenantId: string; adminUserId: string; temporaryPassword: string } | Refused> =>
  post("/platform/clinics", input);

export const setSuspension = (
  tenantId: string,
  input: { suspended: boolean; reason?: string },
): Promise<{ ok: true; status: string } | Refused> => post(`/platform/clinics/${tenantId}/suspension`, input);

export const resetAdminPassword = (
  tenantId: string,
  userId: string,
): Promise<{ ok: true; fullName: string; temporaryPassword: string } | Refused> =>
  post(`/platform/clinics/${tenantId}/admins/${userId}/password`);

// ---------------------------------------------------------------------------------------------
// Operators — 2a
// ---------------------------------------------------------------------------------------------

export async function loadOperators(): Promise<Operator[]> {
  const response = await send("/platform/operators");
  if (!response.ok) throw new Error(`GET /platform/operators -> ${response.status}`);
  return ((await response.json()) as { operators: Operator[] }).operators;
}

export const createOperator = (input: {
  fullName: string;
  phone: string;
  operatorRole: string;
}): Promise<{ ok: true; userId: string; temporaryPassword: string } | Refused> => post("/platform/operators", input);

export const setOperatorRole = (
  userId: string,
  operatorRole: string,
): Promise<{ ok: true; platformRole: string } | Refused> => post(`/platform/operators/${userId}/role`, { operatorRole });

/** OWNER only. The reason is required — clearing somebody's second factor is a break-glass act. */
export const resetOperatorTotp = (
  userId: string,
  reason: string,
): Promise<{ ok: true; fullName: string } | Refused> =>
  post(`/platform/operators/${userId}/totp/reset`, { reason });

// ---------------------------------------------------------------------------------------------
// The client file — 2b and 2c
// ---------------------------------------------------------------------------------------------

export async function loadClientFile(tenantId: string): Promise<ClientFile> {
  const response = await send(`/platform/clinics/${tenantId}/file`);
  if (!response.ok) throw new Error(`GET /platform/clinics/${tenantId}/file -> ${response.status}`);
  return (await response.json()) as ClientFile;
}

export type ClientFileEdit = Partial<{
  salesOwnerUserId: string | null;
  agreedPlan: string | null;
  agreedMonthlyMinor: number | null;
  discountPercent: number | null;
  accountStatus: string;
  trialEndsOn: string | null;
  renewalOn: string | null;
  notes: string | null;
}>;

export const saveClientFile = (tenantId: string, edit: ClientFileEdit): Promise<{ ok: true } | Refused> =>
  post(`/platform/clinics/${tenantId}/file`, edit);

export const addContact = (
  tenantId: string,
  input: { contactName: string; contactRole?: string; contactPhone?: string; contactEmail?: string },
): Promise<{ ok: true; id: string } | Refused> => post(`/platform/clinics/${tenantId}/contacts`, input);

export const removeContact = (tenantId: string, contactId: string): Promise<{ ok: true } | Refused> =>
  post(`/platform/clinics/${tenantId}/contacts/${contactId}/remove`);

export function addContract(
  tenantId: string,
  input: { file: File; startsOn: string; endsOn: string },
): Promise<{ ok: true; id: string } | Refused> {
  const form = new FormData();
  form.append("file", input.file);
  form.append("startsOn", input.startsOn);
  form.append("endsOn", input.endsOn);
  return post(`/platform/clinics/${tenantId}/contracts`, form);
}

/**
 * Fetches the PDF and hands the browser a blob to save.
 *
 * Not an `<a href>` to the route: the bytes come back behind a bearer token the browser would not
 * attach to a plain navigation, and the storage interface has no URL to link to in the first place.
 */
export async function downloadContract(tenantId: string, contractId: string, fileName: string): Promise<boolean> {
  const response = await send(`/platform/clinics/${tenantId}/contracts/${contractId}/content`);
  if (!response.ok) return false;

  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
  return true;
}
