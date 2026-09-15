import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { clearCachedLocale } from "../../i18n/locale-store.ts";

/**
 * The signed-in session: the access token, who it belongs to, and the one fetch wrapper everything
 * else uses.
 *
 * ## The access token lives in memory, not in storage
 *
 * Not `localStorage`, not a readable cookie. A token in storage survives the tab, is readable by
 * any script on the origin, and on a shared reception workstation outlives the person who signed
 * in. Fifteen minutes of exposure in a closure is the trade the short TTL exists to make. The
 * consequence — a page refresh drops the session and silently refreshes from the httpOnly cookie —
 * is the behaviour we want anyway.
 *
 * ## Expiry is handled by retrying, not by watching a clock
 *
 * The access token lasts fifteen minutes, and a receptionist on a quiet morning will cross that
 * boundary mid-session. Nothing here tracks the expiry: a timer drifts, sleeps with the laptop, and
 * is wrong the moment the server disagrees. Instead `authFetch` treats a 401 as "the token expired,
 * probably" and does exactly one refresh-and-retry.
 *
 * **Exactly one.** A second failure means the refresh token is gone too — revoked, expired, or the
 * family was killed by a reuse elsewhere — and retrying again would be a loop that hammers the
 * endpoint while the user watches a spinner. The session ends and the login screen returns.
 *
 * Concurrent 401s share one refresh. Without that, a screen firing three requests as the token
 * expires would rotate the refresh token three times; rotation is single-use, so two of those would
 * be *replays* and the family-reuse detection would revoke the whole session — logging the user out
 * for the crime of having a page with three panels on it.
 */

export interface Membership {
  membershipId: string;
  tenantId: string;
  tenantName: string;
  tenantSlug: string;
  role: string;
}

export interface CurrentUser {
  user: { id: string; fullName: string; phoneE164: string; email: string | null; locale: string | null };
  membershipId: string;
  tenantId: string;
  /** ISO 4217 code from `tenants.currency`. Never assume EGP — `formatMinor` takes it as input. */
  currency: string;
  role: string;
  memberships: Membership[];
  /** DISPLAY HINT ONLY (see permissions.ts). Hides controls; authorises nothing. */
  permissions: Record<string, "full" | "own" | "none">;
}

interface SessionValue {
  me: CurrentUser;
  /** Fetch with the access token attached, refreshing once on expiry. */
  authFetch: (path: string, init?: RequestInit) => Promise<Response>;
  /** Re-reads `/auth/me`. Called after switching tenant, so the header shows the new clinic. */
  reload: () => Promise<void>;
  logout: () => Promise<void>;
  switchTenant: (membershipId: string) => Promise<boolean>;
}

const SessionContext = createContext<SessionValue | undefined>(undefined);

export function useSession(): SessionValue {
  const value = useContext(SessionContext);
  if (value === undefined) throw new Error("useSession() outside a <SessionProvider>.");
  return value;
}

/** Reads `/auth/me` with a token. Exported so the login screen can establish a session. */
export async function fetchMe(accessToken: string): Promise<CurrentUser | null> {
  const response = await fetch("/api/auth/me", {
    headers: { authorization: `Bearer ${accessToken}` },
    credentials: "include",
  });
  return response.ok ? ((await response.json()) as CurrentUser) : null;
}

export function SessionProvider({
  initialToken,
  initialMe,
  onSignedOut,
  children,
}: {
  initialToken: string;
  initialMe: CurrentUser;
  onSignedOut: () => void;
  children: ReactNode;
}) {
  const token = useRef(initialToken);
  const [me, setMe] = useState<CurrentUser>(initialMe);
  /** The in-flight refresh, shared by every caller that hits a 401 at the same moment. */
  const refreshing = useRef<Promise<boolean> | null>(null);

  /**
   * Ends the session locally and returns to the login screen.
   *
   * **Clears the cached locale**, and does so by calling the same `clearCachedLocale` the D20 tests
   * cover rather than removing the key by hand. Reception shares one workstation and one browser
   * profile: without this, a doctor's English preference persists into whoever signs in next. A
   * second implementation here would be a second thing to keep correct, and the one nobody tests.
   */
  const endSession = useCallback(() => {
    token.current = "";
    try {
      clearCachedLocale(window.localStorage);
    } catch {
      // Storage unavailable. Nothing cached means nothing to leak.
    }
    onSignedOut();
  }, [onSignedOut]);

  const refresh = useCallback(async (): Promise<boolean> => {
    refreshing.current ??= (async () => {
      try {
        const response = await fetch("/api/auth/refresh", { method: "POST", credentials: "include" });
        if (!response.ok) return false;
        const body = (await response.json()) as { accessToken: string };
        token.current = body.accessToken;
        return true;
      } catch {
        return false;
      } finally {
        // Cleared regardless of outcome, so the next expiry starts a fresh attempt rather than
        // resolving instantly against a stale result.
        refreshing.current = null;
      }
    })();
    return refreshing.current;
  }, []);

  const authFetch = useCallback(
    async (path: string, init: RequestInit = {}): Promise<Response> => {
      const send = (): Promise<Response> =>
        fetch(path, {
          ...init,
          credentials: "include",
          headers: { ...(init.headers ?? {}), authorization: `Bearer ${token.current}` },
        });

      const first = await send();
      if (first.status !== 401) return first;

      if (!(await refresh())) {
        endSession();
        return first;
      }
      return send();
    },
    [refresh, endSession],
  );

  const reload = useCallback(async () => {
    const next = await fetchMe(token.current);
    if (next) setMe(next);
  }, []);

  const logout = useCallback(async () => {
    // Best-effort: the server revokes the family, but a failed network call must not strand the
    // user in a session they asked to leave. The local end happens either way.
    await fetch("/api/auth/logout", { method: "POST", credentials: "include" }).catch(() => undefined);
    endSession();
  }, [endSession]);

  const switchTenant = useCallback(
    async (membershipId: string): Promise<boolean> => {
      const response = await authFetch("/api/auth/switch-tenant", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ membershipId }),
      });
      if (!response.ok) return false;
      const body = (await response.json()) as { accessToken: string };
      token.current = body.accessToken;
      // The header reads from `me`, so it must be re-read or the clinic name would not change and
      // the switch would look like it had not happened.
      await reload();
      return true;
    },
    [authFetch, reload],
  );

  const value = useMemo<SessionValue>(
    () => ({ me, authFetch, reload, logout, switchTenant }),
    [me, authFetch, reload, logout, switchTenant],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}
