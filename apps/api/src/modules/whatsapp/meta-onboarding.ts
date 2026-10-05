// The server-to-server half of Embedded Signup for a Tech Provider: exchange the one-time code for
// the clinic's business token, prove the clinic really owns the WABA and number the browser
// reported, then subscribe our app to that WABA and register the number for Cloud API.
// https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-customers-as-a-tech-provider
//
// Plain fetch, like whatsapp-graph-client.ts. Never called from the browser: it carries the app
// secret and the clinic's token.

export const META_GRAPH_VERSION = process.env["WHATSAPP_GRAPH_VERSION"] ?? "v26.0";

export type OnboardingStep = "EXCHANGE_CODE" | "VERIFY_NUMBER" | "SUBSCRIBE_WEBHOOKS" | "REGISTER_NUMBER";

export class MetaOnboardingError extends Error {
  constructor(
    readonly step: OnboardingStep,
    readonly status: number,
    detail: string,
  ) {
    super(`Meta onboarding failed at ${step}: ${status} ${detail}`);
  }
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
