// The server-to-server half of Embedded Signup for a Tech Provider: exchange the one-time code for
// the clinic's business token, prove the clinic really owns the WABA and number the browser
// reported, then subscribe our app to that WABA and register the number for Cloud API.
// https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-customers-as-a-tech-provider
//
// Plain fetch, like whatsapp-graph-client.ts. Never called from the browser: it carries the app
// secret and the clinic's token.

export const META_GRAPH_VERSION = process.env["WHATSAPP_GRAPH_VERSION"] ?? "v26.0";

export type OnboardingStep = "EXCHANGE_CODE" | "VERIFY_NUMBER" | "SUBSCRIBE_WEBHOOKS" | "REGISTER_NUMBER" | "SYNC_DATA";

export class MetaOnboardingError extends Error {
  constructor(
    readonly step: OnboardingStep,
    readonly status: number,
    detail: string,
  ) {
    super(`Meta onboarding failed at ${step}: ${status} ${detail}`);
  }
}

export interface ResolvedNumber {
  phoneNumberId: string;
  displayPhoneNumber: string | null;
  verifiedName: string | null;
  /** True while the number is also live in the WhatsApp Business app (coexistence). */
  isOnBizApp: boolean;
}

interface RawWabaNumber {
  id: string;
  display_phone_number?: string;
  verified_name?: string;
  is_on_biz_app?: boolean;
}

async function fetchWabaNumbers(accessToken: string, wabaId: string, fields: string): Promise<Response> {
  return fetch(`${graphUrl(`${encodeURIComponent(wabaId)}/phone_numbers`)}?fields=${fields}`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
}

/**
 * Like `findAuthorizedNumber`, but the number may be unnamed. Meta's coexistence completion event
 * (`FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING`) carries the WABA id and no phone_number_id, so for that
 * flow the browser has nothing to claim and the server finds the number itself, from the clinic's own
 * token: the WABA's only number, or, if there are several, the only one that is on the Business app.
 * When the browser DID name a number, it is still only accepted if the token can list it.
 */
export async function resolveAuthorizedNumber(
  accessToken: string,
  wabaId: string,
  claimedPhoneNumberId: string | null,
): Promise<ResolvedNumber | null> {
  // `is_on_biz_app` is what tells a coexistence number apart; if Meta refuses the field, the plain
  // list still answers the "does this token own that number" question.
  let response = await fetchWabaNumbers(accessToken, wabaId, "id,display_phone_number,verified_name,is_on_biz_app");
  if (!response.ok) response = await fetchWabaNumbers(accessToken, wabaId, "id,display_phone_number,verified_name");
  if (!response.ok) throw await failure("VERIFY_NUMBER", response);

  const numbers = ((await response.json()) as { data?: RawWabaNumber[] }).data ?? [];
  let match: RawWabaNumber | undefined;
  if (claimedPhoneNumberId !== null) {
    match = numbers.find((entry) => entry.id === claimedPhoneNumberId);
  } else {
    const onBizApp = numbers.filter((entry) => entry.is_on_biz_app === true);
    const pool = onBizApp.length > 0 ? onBizApp : numbers;
    match = pool.length === 1 ? pool[0] : undefined;
  }
  if (match === undefined) return null;

  return {
    phoneNumberId: match.id,
    displayPhoneNumber: match.display_phone_number ?? null,
    verifiedName: match.verified_name ?? null,
    isOnBizApp: match.is_on_biz_app === true,
  };
}

/**
 * Coexistence's two required one-time syncs. Meta gives 24 hours from onboarding to ask for each;
 * miss the window and the clinic has to offboard and run Embedded Signup again. Asking is what
 * matters: the contacts and history Meta then sends to the webhook are acknowledged and dropped
 * (whatsapp.controller.ts).
 *   - `smb_app_state_sync`: the clinic's contacts.
 *   - `history`: up to 180 days of one-to-one chats.
 */
export async function requestSmbAppDataSync(
  accessToken: string,
  phoneNumberId: string,
  syncType: "smb_app_state_sync" | "history",
): Promise<void> {
  const response = await fetch(graphUrl(`${encodeURIComponent(phoneNumberId)}/smb_app_data`), {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ messaging_product: "whatsapp", sync_type: syncType }),
  });
  if (!response.ok) throw await failure("SYNC_DATA", response);
}

function graphUrl(path: string): string {
  return `https://graph.facebook.com/${META_GRAPH_VERSION}/${path}`;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set -- see .env.example.`);
  return value;
}

async function failure(step: OnboardingStep, response: Response): Promise<MetaOnboardingError> {
  return new MetaOnboardingError(step, response.status, await response.text());
}

/**
 * Trades the code from `FB.login` (30-second lifetime, single use) for the clinic's business token.
 * `WHATSAPP_APP_SECRET` is the same secret that verifies webhook signatures: one Meta app, one secret.
 */
export async function exchangeSignupCode(code: string): Promise<{ accessToken: string; expiresInSeconds: number | null }> {
  const query = new URLSearchParams({
    client_id: requireEnv("WHATSAPP_APP_ID"),
    client_secret: requireEnv("WHATSAPP_APP_SECRET"),
    code,
  });
  const response = await fetch(`${graphUrl("oauth/access_token")}?${query.toString()}`);
  if (!response.ok) throw await failure("EXCHANGE_CODE", response);

  const data = (await response.json()) as { access_token?: string; expires_in?: number };
  if (!data.access_token) throw new MetaOnboardingError("EXCHANGE_CODE", 200, "response carried no access_token");
  return { accessToken: data.access_token, expiresInSeconds: data.expires_in ?? null };
}

export interface AuthorizedNumber {
  displayPhoneNumber: string | null;
  verifiedName: string | null;
}

/**
 * The `waba_id` and `phone_number_id` arrive from the browser's message event, which is the
 * caller's own claim. The token is the proof: it can only list a WABA's numbers if the clinic
 * granted this app that WABA, so a claim about someone else's ids fails here (Meta returns an
 * error) or comes back without the number. `null` means the number is not on that WABA.
 */
export async function findAuthorizedNumber(
  accessToken: string,
  wabaId: string,
  phoneNumberId: string,
): Promise<AuthorizedNumber | null> {
  const response = await fetch(`${graphUrl(`${encodeURIComponent(wabaId)}/phone_numbers`)}?fields=id,display_phone_number,verified_name`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) throw await failure("VERIFY_NUMBER", response);

  const data = (await response.json()) as {
    data?: Array<{ id: string; display_phone_number?: string; verified_name?: string }>;
  };
  const match = data.data?.find((entry) => entry.id === phoneNumberId);
  if (!match) return null;
  return { displayPhoneNumber: match.display_phone_number ?? null, verifiedName: match.verified_name ?? null };
}

/** Without this the clinic's messages never reach our callback URL, however the dashboard looks. */
export async function subscribeAppToWaba(accessToken: string, wabaId: string): Promise<void> {
  const response = await fetch(graphUrl(`${encodeURIComponent(wabaId)}/subscribed_apps`), {
    method: "POST",
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) throw await failure("SUBSCRIBE_WEBHOOKS", response);
}

/**
 * Registers a number for Cloud API. The PIN becomes the number's two-step verification PIN; it is
 * random and is not kept, because Meta lets whoever holds a valid business token set a new one.
 * Skipped for a number that came from the WhatsApp Business app (coexistence): already registered.
 */
export async function registerPhoneNumber(accessToken: string, phoneNumberId: string, pin: string): Promise<void> {
  const response = await fetch(graphUrl(`${encodeURIComponent(phoneNumberId)}/register`), {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ messaging_product: "whatsapp", pin }),
  });
  if (!response.ok) throw await failure("REGISTER_NUMBER", response);
}
