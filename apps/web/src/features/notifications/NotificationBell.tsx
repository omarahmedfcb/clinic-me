import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "../../design-system/Button.tsx";
import { intlLocale } from "../../i18n/format.ts";
import { useLocale } from "../../i18n/locale-context.tsx";
import type { TranslationKey } from "../../i18n/strings.ts";
import { useSession } from "../auth/session.tsx";
import { setSoundEnabled, soundEnabled } from "./sound-preference.ts";
import { notificationSound } from "./sound.ts";
import { NOTIFICATION_POLL_MS } from "../../lib/polling.ts";

/**
 * The notification bell: an unread count, a dropdown of recent items, and mark-as-read.
 *
 * ## Polling, at fifteen seconds
 *
 * `ARCHITECTURE.md` locks realtime to 15-second polling rather than SSE in V1, and that holds here
 * for a reason stronger than consistency: **the latency a receptionist would accept is not the
 * notification's, it is the patient's.** A WhatsApp booking that appears within fifteen seconds is
 * indistinguishable from instant, because nobody is standing at the desk waiting for it. The one
 * case that would feel slow — a patient physically present while reception books — is not a
 * notification case at all, since the receptionist is the one doing the booking.
 *
 * So the bell polls one count endpoint, which is deliberately the cheapest query in the module, and
 * fetches the list only when opened.
 *
 * ## Sound, and why the mute toggle ships with it rather than after
 *
 * Audio in a shared, public-facing reception room needs a way to turn it off, so the toggle is not
 * a settings screen — it is one control next to the thing it silences, which is where a
 * receptionist will look for it at the moment they want it.
 *
 * OFF by default, per device (see `sound.ts`). Sound is never the notification — the badge is —
 * so a browser that refuses to play costs speed and nothing else. When `play()` is refused the
 * banner says so, because a clinic that believes it will be alerted and is not is worse off than
 * one that knows.
 */

interface NotificationItem {
  id: string;
  kind: "APPOINTMENT_BOOKED" | "APPOINTMENT_CANCELLED" | "APPOINTMENT_RESCHEDULED";
  occurredAt: string;
  source: string;
  payload: { patientName?: string | null; start?: string; from?: string; reason?: string | null };
  read: boolean;
}


const POLL_MS = NOTIFICATION_POLL_MS;

export function NotificationBell() {
  const { t, locale } = useLocale();
  const { authFetch } = useSession();

  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [sound, setSound] = useState(() => soundEnabled(window.localStorage));
  const [audioBlocked, setAudioBlocked] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  /** The previous count, so a rise can be told from a first load or a mark-as-read. */
  const lastCount = useRef<number | null>(null);

  const refreshCount = useCallback(async (): Promise<void> => {
    try {
      const response = await authFetch("/api/notifications/count");
      if (!response.ok) return;
      const next = ((await response.json()) as { unread: number }).unread;

      // Only on a RISE, and never on the first poll of the session -- otherwise signing in with
      // yesterday's unread items would chime for news that is not new.
      const previous = lastCount.current;
      lastCount.current = next;
      setUnread(next);

      if (previous !== null && next > previous && soundEnabled(window.localStorage)) {
        const played = await notificationSound.play();
        // The rejection is surfaced, not swallowed. This is the branch that stops a clinic
        // believing it will be alerted when it will not be.
        setAudioBlocked(!played);
      }
    } catch {
      // A failed poll is not worth telling anyone about; the next one is fifteen seconds away.
    }
  }, [authFetch]);

  useEffect(() => {
    void refreshCount();
    const timer = window.setInterval(() => void refreshCount(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [refreshCount]);

  /** Closing on an outside click, so the panel does not sit over the screen behind it. */
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent): void => {
      if (panel.current !== null && !panel.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  async function toggle(): Promise<void> {
    const next = !open;
    setOpen(next);
    if (!next) return;

    setLoading(true);
    try {
      const response = await authFetch("/api/notifications");
      if (response.ok) setItems(((await response.json()) as { items: NotificationItem[] }).items);
    } finally {
      setLoading(false);
    }
  }

  async function markAllRead(): Promise<void> {
    const ids = items.filter((item) => !item.read).map((item) => item.id);
    if (ids.length === 0) return;

    const response = await authFetch("/api/notifications/read", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids }),
    });
    if (!response.ok) return;

    setItems((current) => current.map((item) => ({ ...item, read: true })));
    await refreshCount();
  }

  const time = new Intl.DateTimeFormat(intlLocale(locale), {
    timeZone: "Africa/Cairo",
    dateStyle: "short",
    timeStyle: "short",
    hour12: false,
  });

  return (
    <div className="relative flex items-center gap-1" ref={panel}>
      <Button
        variant="ghost"
        size="sm"
        aria-label={sound ? t("notifications.sound.on") : t("notifications.sound.off")}
        title={sound ? t("notifications.sound.on") : t("notifications.sound.off")}
        onClick={() => {
          const next = !sound;
          setSound(next);
          setSoundEnabled(window.localStorage, next);
          if (next) {
            // Turning sound ON is itself a user gesture -- the best moment to unlock, and to find
            // out immediately whether the browser will allow it rather than at the next booking.
            notificationSound.unlock();
            void notificationSound.play().then((played) => setAudioBlocked(!played));
          } else {
            setAudioBlocked(false);
          }
        }}
      >
        {sound ? "🔔" : "🔕"}
      </Button>

      <Button variant="ghost" size="sm" onClick={() => void toggle()}>
        {t("notifications.open")}
        {unread > 0 && (
          <span className="ms-2 rounded-full bg-danger px-1.5 py-0.5 text-[11px] text-white">
            {unread}
          </span>
        )}
      </Button>

      {audioBlocked && (
        <div
          role="alert"
          className="absolute end-0 top-full z-30 mt-1 w-72 rounded-lg border border-border bg-warning-soft px-3 py-2 text-xs text-warning"
        >
          {t("notifications.sound.blocked")}
          <button
            type="button"
            className="ms-2 underline"
            onClick={() => {
              notificationSound.unlock();
              void notificationSound.play().then((played) => setAudioBlocked(!played));
            }}
          >
            {t("notifications.sound.enable")}
          </button>
        </div>
      )}

      {open && (
        /*
          `end-0` is a logical property -- the panel hangs from the inline END of the bell, which is
          the left in Arabic and the right in English. web-logical-properties.spec.ts fails the
          build on a physical side, and a dropdown is exactly where a hardcoded one goes unnoticed:
          it is accidentally correct in whichever language it was written in.
        */
        <div className="absolute end-0 top-full z-20 mt-2 w-80 rounded-xl border border-border bg-surface shadow-lg">
          <div className="flex items-center justify-between border-b border-border px-3 py-2">
            <span className="text-sm font-semibold">{t("notifications.title")}</span>
            {items.some((item) => !item.read) && (
              <Button variant="ghost" size="sm" onClick={() => void markAllRead()}>
                {t("notifications.markAllRead")}
              </Button>
            )}
          </div>

          <ul className="max-h-96 overflow-y-auto">
            {loading && <li className="px-3 py-4 text-sm text-ink-muted">…</li>}

            {!loading && items.length === 0 && (
              <li className="px-3 py-6 text-center text-sm text-ink-muted">
                {t("notifications.empty")}
              </li>
            )}

            {items.map((item) => (
              <li
                key={item.id}
                className={
                  item.read
                    ? "border-b border-border px-3 py-2 last:border-b-0"
                    : "border-b border-border bg-primary-soft/40 px-3 py-2 last:border-b-0"
                }
              >
                <div className="flex items-center gap-2">
                  {!item.read && (
                    <span
                      aria-label={t("notifications.unread")}
                      className="size-1.5 shrink-0 rounded-full bg-primary"
                    />
                  )}
                  <span className="text-sm font-medium">
                    {t(`notifications.kind.${item.kind}` as TranslationKey)}
                  </span>
                  <span className="ms-auto text-[11px] text-ink-muted">
                    {t(`notifications.source.${item.source}` as TranslationKey)}
                  </span>
                </div>

                <p className="mt-0.5 text-sm text-ink-subtle">
                  {item.payload.patientName ?? ""}
                  {item.payload.start !== undefined && ` · ${time.format(new Date(item.payload.start))}`}
                </p>

                {item.payload.reason != null && item.payload.reason !== "" && (
                  <p className="text-xs text-ink-muted">{item.payload.reason}</p>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
