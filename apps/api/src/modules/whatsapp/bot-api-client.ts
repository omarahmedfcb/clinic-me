// The WhatsApp integration's own half of docs/WHATSAPP-BOT-CONTRACT.md -- it is "the developer" the
// contract is written for, just living in the same repository. Unlike the web chat
// (webchat-clinics.ts, which builds an AI_AGENT caller context in-process because it "runs inside
// the same trusted API"), this client never imports a service function or touches Prisma. It
// exchanges a credential for a token at POST /bot/auth/token, the same door an outside developer's
// bot would use, and calls every capability over plain HTTP after that -- so the boundary
// WHATSAPP-BOT-CONTRACT.md §1 draws ("the bot is a client of the API, never a client of the
// database") is a real process boundary here too, not just a comment.
//
// Plain fetch, no HTTP client dependency -- the same choice gpt-client.ts already made, and nothing
// else in this codebase reaches for one either.

export interface BotCredentialConfig {
  apiBaseUrl: string;
  credentialId: string;
  secret: string;
}

/**
 * One clinic's credential for now, read from the environment. `API_BASE_URL` /
 * `BOT_CREDENTIAL_ID` / `BOT_CREDENTIAL_SECRET` -- issued once via the existing
 * `POST /clinic/bot-credential` admin route and pasted into `.env`, exactly as an external
 * developer would receive and store them.
 *
 * This is the single-tenant simplification `webchat-prototype.md`'s "start simple" scope calls for:
 * one Meta test number, one clinic, one credential. Serving more than one clinic later means this
 * function reads from a per-tenant store (a new table, keyed on `whatsappPhoneNumberId`) instead of
 * `process.env` -- everything downstream of `BotApiClient` is already written against an instance,
 * not a global, so that change stays local to this one function.
 */
export function defaultBotCredentialConfig(): BotCredentialConfig {
  const apiBaseUrl = process.env["API_BASE_URL"] ?? "http://localhost:3000";
  const credentialId = process.env["BOT_CREDENTIAL_ID"];
  const secret = process.env["BOT_CREDENTIAL_SECRET"];
  if (!credentialId || !secret) {
    throw new Error(
      "BOT_CREDENTIAL_ID / BOT_CREDENTIAL_SECRET are not set -- issue one with POST /clinic/bot-credential " +
      "(clinicSettings.manage) and put its id and secret in .env. See .env.example.",
    );
  }
  return { apiBaseUrl, credentialId, secret };
}

export interface BotHouseholdMember {
  patientId: string;
  displayName: string;
  relationshipToContact: string;
  intakeIncomplete: boolean;
}

export interface BotDoctor {
  id: string;
  fullName: string;
  title: string;
  specialty: string;
}

export interface BotService {
  id: string;
  nameAr: string;
  nameEn: string;
  durationMinutes: number;
}

/** `/bot/slots` returns the slot engine's own shape unchanged (bot.controller.ts: `{ slots:
 *  result.slots }`) -- token plus a raw instant, JSON-serialized. Formatting it into the clinic's
 *  local wall-clock time is the caller's job (clinic-time.ts), same as webchat-tools.ts already does. */
export interface BotSlot {
  token: string;
  start: string;
}

export type BotResult<T> = { ok: true; value: T } | { ok: false; status: number; code: string; params?: unknown };

/**
 * One token per credential, refreshed a minute before its known 15-minute expiry (jwt.ts's
 * `ACCESS_TOKEN_TTL_SECONDS`) or immediately on a 401, whichever comes first -- a clock skew or a
 * revoked-then-reissued credential should never wait out a stale cache.
 */
const EARLY_REFRESH_MS = 60_000;
const ACCESS_TOKEN_TTL_MS = 15 * 60_000;

interface CachedToken {
  accessToken: string;
  expiresAt: number;
}

export class BotApiClient {
  private cached: CachedToken | undefined;

  constructor(private readonly config: BotCredentialConfig) { }

  private async token(forceRefresh: boolean): Promise<string> {
    if (!forceRefresh && this.cached && this.cached.expiresAt > Date.now()) {
      return this.cached.accessToken;
    }

    const response = await fetch(`${this.config.apiBaseUrl}/bot/auth/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ credentialId: this.config.credentialId, secret: this.config.secret }),
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`bot/auth/token failed: ${response.status} ${body}`);
    }
    const data = (await response.json()) as { accessToken: string };
    this.cached = { accessToken: data.accessToken, expiresAt: Date.now() + ACCESS_TOKEN_TTL_MS - EARLY_REFRESH_MS };
    return data.accessToken;
  }

  /**
   * One request, with exactly one retry after a fresh token -- a 401 here means the cached token
   * expired early or the credential was reissued mid-cache, never that the caller should retry a
   * loop. Every non-2xx that is not a 401 is decoded as `{ code, params }` (refusals.ts's own
   * shape, docs/REFUSAL-CODES.md) so a caller can branch on it the way the contract's §7 describes.
   */
  private async request<T>(path: string, init: RequestInit): Promise<BotResult<T>> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const accessToken = await this.token(attempt > 0);
      const response = await fetch(`${this.config.apiBaseUrl}${path}`, {
        ...init,
        headers: { ...init.headers, authorization: `Bearer ${accessToken}` },
      });

      if (response.status === 401 && attempt === 0) continue;

      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { code?: string; params?: unknown };
        console.error(`WhatsApp bot API: ${init.method ?? "GET"} ${path} -> ${response.status}`, {
          code: body.code ?? "UNKNOWN",
          params: body.params,
        });
        return { ok: false, status: response.status, code: body.code ?? "UNKNOWN", params: body.params };
      }

      return { ok: true, value: (await response.json()) as T };
    }

    return { ok: false, status: 401, code: "INVALID_CREDENTIAL" };
  }

  async findPatientsByPhone(phone: string): Promise<BotResult<{ patients: BotHouseholdMember[] }>> {
    return this.request(`/bot/patients?phone=${encodeURIComponent(phone)}`, { method: "GET" });
  }

  async createProvisionalPatient(input: {
    fullNameAr: string;
    phoneE164: string;
  }): Promise<BotResult<{ patientId: string; displayName: string }>> {
    return this.request("/bot/patients", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
  }

  async listDoctors(): Promise<BotResult<{ doctors: BotDoctor[] }>> {
    return this.request("/bot/doctors", { method: "GET" });
  }

  async listServices(): Promise<BotResult<{ services: BotService[] }>> {
    return this.request("/bot/services", { method: "GET" });
  }

  async listSlots(input: {
    doctorId: string;
    serviceId: string;
    date: string;
  }): Promise<BotResult<{ slots: BotSlot[] }>> {
    const query = new URLSearchParams(input).toString();
    return this.request(`/bot/slots?${query}`, { method: "GET" });
  }

  /** `/bot/appointments` returns `{ ok: true, appointmentId, start, end }` as-is on success
   *  (bot.controller.ts's `book` route returns the booking result directly) -- `start`/`end` are
   *  JSON-serialized instants, not yet in the clinic's local time. */
  async bookAppointment(input: {
    slotToken: string;
    patientId: string;
    consentMessageId: string;
  }): Promise<BotResult<{ appointmentId: string; start: string; end: string }>> {
    return this.request("/bot/appointments", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
  }

  /** `/bot/complaints` returns `{ complaintId, referenceNumber }` on success (bot.controller.ts's
   *  `complaint` route) -- the reference number is what the flow reads back to the patient. */
  async createComplaint(input: {
    patientId: string;
    description: string;
    consentMessageId: string;
  }): Promise<BotResult<{ complaintId: string; referenceNumber: string }>> {
    return this.request("/bot/complaints", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
  }

  /** Not offered via GPT function-calling -- the WhatsApp flow (whatsapp-flow.ts) calls this client
   *  directly, and reschedule/cancel/status are simply not steps it has yet. */
  async rescheduleAppointment(
    appointmentId: string,
    slotToken: string,
  ): Promise<BotResult<{ appointmentId: string }>> {
    return this.request(`/bot/appointments/${appointmentId}/reschedule`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ slotToken }),
    });
  }

  async cancelAppointment(appointmentId: string, reason?: string): Promise<BotResult<{ appointmentId: string }>> {
    return this.request(`/bot/appointments/${appointmentId}/cancel`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(reason === undefined ? {} : { reason }),
    });
  }

  /** `/bot/appointments/:id` returns `bot.service.ts#readAppointmentStatus`'s shape directly, with
   *  no `ok` wrapper on success (a 404 is the failure path instead) -- `scheduledStart` JSON-serialized. */
  async readAppointmentStatus(
    appointmentId: string,
  ): Promise<BotResult<{ appointmentId: string; status: string; scheduledStart: string; doctorName: string }>> {
    return this.request(`/bot/appointments/${appointmentId}`, { method: "GET" });
  }
}

let singleton: BotApiClient | undefined;

/** One client for the one clinic this pass supports. See `defaultBotCredentialConfig`'s note on
 *  what changes when a second clinic needs one. */
export function getDefaultBotApiClient(): BotApiClient {
  singleton ??= new BotApiClient(defaultBotCredentialConfig());
  return singleton;
}
