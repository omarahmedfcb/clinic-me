import { useCallback, useEffect, useState } from "react";
import { Button } from "../../design-system/Button.tsx";
import { intlLocale } from "../../i18n/format.ts";
import { useLocale } from "../../i18n/locale-context.tsx";
import { useSession } from "../auth/session.tsx";

/**
 * Shown on every screen while the assistant is silent on one or more WhatsApp chats because a person
 * has them (staff replied from the Business app, or the patient asked for someone). The pause lapses
 * by itself after a few hours; this is the button that ends it sooner, for one chat or all of them.
 *
 * Same capability as the bell it complements (`appointments.read`), and the same endpoints.
 */

interface PausedChat {
  conversationId: string;
  phone: string;
  pausedUntil: string;
}

const POLL_MS = 30_000;
/** Beyond this many chats the per-chat buttons would fill the bar; "return all" is the control then. */
const MAX_LISTED = 4;

export function HandoffBanner() {
  const { t, locale } = useLocale();
  const { authFetch, me } = useSession();
  const allowed = me.permissions["appointments.read"] !== "none";

  const [chats, setChats] = useState<PausedChat[]>([]);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const response = await authFetch("/api/whatsapp/handoffs");
      if (!response.ok) return;
      setChats(((await response.json()) as { items: PausedChat[] }).items);
    } catch {
      // A banner that is briefly stale is not worth an error of its own; the next poll is 30 seconds away.
    }
  }, [authFetch]);

  useEffect(() => {
    if (!allowed) return;
    void refresh();
    const timer = window.setInterval(() => void refresh(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [allowed, refresh]);

  async function resume(path: string): Promise<void> {
    if (busy) return;
    setBusy(true);
    setFailed(false);
    try {
      const response = await authFetch(path, { method: "POST" });
      if (!response.ok) setFailed(true);
      await refresh();
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  if (!allowed || chats.length === 0) return null;

  const clock = new Intl.DateTimeFormat(intlLocale(locale), {
    timeZone: "Africa/Cairo",
    timeStyle: "short",
    hour12: false,
  });

  return (
    <div
      role="status"
      data-testid="handoff-banner"
      className="flex flex-wrap items-center gap-3 border-b border-border bg-warning-soft px-4 py-2 text-sm text-warning"
    >
      <div className="min-w-0 flex-1">
        <p>{t("handoff.banner.text").replace("{count}", String(chats.length))}</p>
        {failed && <p className="mt-1 font-medium">{t("handoff.banner.error")}</p>}
        {chats.length <= MAX_LISTED && (
          <ul className="mt-1 flex flex-wrap gap-2">
            {chats.map((chat) => (
              <li key={chat.conversationId} className="flex items-center gap-2">
                <span dir="ltr">{chat.phone}</span>
                <span className="text-[11px]">
                  {t("notifications.handoff.until")} {clock.format(new Date(chat.pausedUntil))}
                </span>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={busy}
                  onClick={() => void resume(`/api/whatsapp/handoffs/${chat.conversationId}/resume`)}
                >
                  {t("notifications.handoff.resume")}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
      {(chats.length > 1 || chats.length > MAX_LISTED) && (
        <Button size="sm" loading={busy} onClick={() => void resume("/api/whatsapp/handoffs/resume-all")}>
          {t("handoff.banner.resumeAll")}
        </Button>
      )}
    </div>
  );
}
