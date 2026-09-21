import type { TranslationKey } from "../../i18n/strings.ts";

/**
 * The one call the login screen makes.
 *
 * Kept apart from the component so the mapping from HTTP outcome to message is readable on its own
 * — that mapping is the security-relevant part of this screen, and it is easy to get subtly wrong
 * in the middle of JSX.
 */

export interface LoginSuccess {
  accessToken: string;
  memberships: Array<{ tenantId: string; tenantName: string; role: string }>;
  /** PR 10: a temporary password is outstanding, so the shell is not where this session goes next. */
  mustChangePassword?: boolean;
}

export type LoginResult =
  | { ok: true; data: LoginSuccess }
  | { ok: false; messageKey: TranslationKey; retryable: boolean };

/**
 * Maps a response to a message.
 *
 * **401 and 404 and any other 4xx that is not 429 collapse to one message.** The API returns an
 * identical 401 for a wrong password and for an account that does not exist — deliberately, and
 * with matching timing (`auth-endpoints.integration.spec.ts`). Distinguishing them here would hand
 * back exactly what the server goes to some trouble to hide: an attacker would use the UI as the
 * oracle the API refuses to be.
 *
 * **429 is the exception, and it gets its own message on purpose.** A receptionist who has mistyped
 * a password a few times and is met with "invalid credentials" for the fourth time concludes the
 * system is broken and calls somebody. Telling her she has been locked out for fifteen minutes is
 * both true and actionable, and it reveals nothing: being rate-limited is a fact about her own
 * requests, which she already knows.
 */
export async function login(
  identifier: string,
  password: string,
  options: { rememberMe?: boolean; signal?: AbortSignal } = {},
): Promise<LoginResult> {
  const { rememberMe, signal } = options;
  let response: Response;
  try {
    response = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      // `rememberMe` is a request and not a decision: the server grants it only to a DOCTOR or a
      // RECEPTIONIST, whatever this sends.
      body: JSON.stringify({ identifier, password, ...(rememberMe === undefined ? {} : { rememberMe }) }),
      // The refresh token comes back as an httpOnly cookie; without this the browser discards it
      // and every session would end at the first token expiry.
      credentials: "include",
      signal,
    });
  } catch {
    // Network failure, DNS, offline, or an aborted request. Distinguishable from a rejected
    // credential and worth saying so — "check your connection" is actionable, "wrong password" is
    // actively misleading when the request never arrived.
    return { ok: false, messageKey: "login.error.network", retryable: true };
  }

  if (response.ok) {
    return { ok: true, data: (await response.json()) as LoginSuccess };
  }

  if (response.status === 429) {
    return { ok: false, messageKey: "login.error.rateLimited", retryable: false };
  }

  if (response.status >= 500) {
    return { ok: false, messageKey: "login.error.server", retryable: true };
  }

  // Every other 4xx. Includes 400 from the validation pipe: a malformed body is our bug, not the
  // user's, and telling her the request shape was wrong helps nobody at a reception desk.
  return { ok: false, messageKey: "login.error.invalid", retryable: true };
}
