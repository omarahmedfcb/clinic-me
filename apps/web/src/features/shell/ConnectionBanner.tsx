import { useCallback, useEffect, useState } from "react";
import { Button } from "../../design-system/Button.tsx";
import { useLocale } from "../../i18n/locale-context.tsx";
import type { TranslationKey } from "../../i18n/strings.ts";
import { useSession } from "../auth/session.tsx";
import { fetchSignupConfig } from "../signup/signup-api.ts";
import { launchEmbeddedSignup, loadFacebookSdk } from "../signup/meta-signup.ts";

/**
 * Tells the clinic owner when the clinic's WhatsApp stopped working -- the token Meta gave us is no
 * longer valid, or Meta disconnected the number -- and lets them fix it in place by running Meta's
 * flow again for the same number. Without this the bot just goes quiet and nobody knows why.
 *
 * Only for people who can manage clinic settings: it is the clinic's credential, not the desk's.
 */

interface Connection {
  status: "ACTIVE" | "TOKEN_INVALID" | "DISCONNECTED";
  numberMode: "NEW_NUMBER" | "COEXISTENCE";
  displayPhoneNumber: string | null;
}

const POLL_MS = 60_000;

export function ConnectionBanner() {
  const { t } = useLocale();
  const { authFetch, me } = useSession();
  const canManage = me.permissions["clinicSettings.manage"] !== "none";

  const [connection, setConnection] = useState<Connection | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<TranslationKey | undefined>(undefined);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const response = await authFetch("/api/whatsapp/connection");
      if (!response.ok) return;
      setConnection(((await response.json()) as { connection: Connection | null }).connection);
    } catch {
      // The next poll is a minute away; a banner that is briefly stale is not worth an error of its own.
    }
  }, [authFetch]);

  useEffect(() => {
    if (!canManage) return;
    void refresh();
    const timer = window.setInterval(() => void refresh(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [canManage, refresh]);

  async function reconnect(): Promise<void> {
    if (connection === null || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const config = await fetchSignupConfig();
      if (config === null) return setError("connection.banner.error.UNKNOWN");

      const fb = await loadFacebookSdk(config.appId, config.graphVersion);
      const outcome = await launchEmbeddedSignup(fb, config.configId, {
        existingNumber: connection.numberMode === "COEXISTENCE",
      });
      if (outcome.kind === "cancelled") return;
      if (outcome.kind === "error") return setError("connection.banner.error.UNKNOWN");

      const response = await authFetch("/api/whatsapp/connection/reconnect", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          code: outcome.result.code,
          wabaId: outcome.result.wabaId,
          phoneNumberId: outcome.result.phoneNumberId,
        }),
      });
      if (response.ok) return await refresh();

      const body = (await response.json().catch(() => ({}))) as { reason?: string };
      setError(
        body.reason === "META_NUMBER_MISMATCH"
          ? "connection.banner.error.META_NUMBER_MISMATCH"
          : "connection.banner.error.UNKNOWN",
      );
    } catch {
      setError("connection.banner.error.UNKNOWN");
    } finally {
      setBusy(false);
    }
  }

  if (!canManage || connection === null || connection.status === "ACTIVE") return null;

  return (
    <div
      role="alert"
      className="flex flex-wrap items-center gap-3 border-b border-border bg-danger-soft px-4 py-2 text-sm text-danger"
    >
      <p className="min-w-0 flex-1">
        {t(connection.status === "TOKEN_INVALID" ? "connection.banner.tokenInvalid" : "connection.banner.disconnected")}
        {error !== undefined && <span className="mt-1 block font-medium">{t(error)}</span>}
      </p>
      <Button size="sm" loading={busy} onClick={() => void reconnect()}>
        {t("connection.banner.reconnect")}
      </Button>
    </div>
  );
}
