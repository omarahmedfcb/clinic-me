import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "../../design-system/Button.tsx";
import { intlLocale } from "../../i18n/format.ts";
import { useLocale } from "../../i18n/locale-context.tsx";
import type { TranslationKey } from "../../i18n/strings.ts";
import { useSession } from "../auth/session.tsx";
import { setSoundEnabled, soundEnabled } from "./sound-preference.ts";
import { notificationSound } from "./sound.ts";
import { NOTIFICATION_POLL_MS } from "../../lib/polling.ts";
import { Bell, Volume2, VolumeX } from "lucide-react";

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
  kind:
    | "APPOINTMENT_BOOKED"
    | "APPOINTMENT_CANCELLED"
    | "APPOINTMENT_RESCHEDULED"
    | "COMPLAINT_RECEIVED"
    | "HANDOFF_REQUESTED";
  occurredAt: string;
  source: string;
  payload: {
    patientName?: string | null;
    start?: string;
    from?: string;
    reason?: string | null;
    referenceNumber?: string;
    phone?: string;
  };
  read: boolean;
}

/** A WhatsApp chat the assistant is paused on, because a person has it. */
interface PausedChat {
  conversationId: string;
  phone: string;
  pausedUntil: string;
}

const POLL_MS = NOTIFICATION_POLL_MS;

export function NotificationBell() {
  const { t, locale } = useLocale();
  const { authFetch, me } = useSession();

  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [sound, setSound] = useState(() => soundEnabled(window.localStorage));
  const [audioBlocked, setAudioBlocked] = useState(false);
  const [paused, setPaused] = useState<PausedChat[]>([]);
  const panel = useRef<HTMLDivElement>(null);
  /** The previous count, so a rise can be told from a first load or a mark-as-read. */
  const firstPoll = useRef(true);

  const refreshCount = useCallback(async (): Promise<void> => {
    try {
      const response = await authFetch("/api/notifications/count");
      if (!response.ok) return;
      const body = (await response.json()) as {
        unread: number;
        latestId: string | null;
      };
      setUnread(body.unread);

      const key = `clinic-os:last-chime:${me.membershipId}`;
      let seen: string | null = null;
      try {
        seen = window.localStorage.getItem(key);
      } catch {
        /* storage unavailable */
      }
      const isNew = body.latestId !== null && body.latestId !== seen;
      if (isNew) {
        try {
          window.localStorage.setItem(key, body.latestId as string);
        } catch {
          /* as above */
        }
      }

      const wasFirst = firstPoll.current;
      firstPoll.current = false;

      if (
        isNew &&
        !wasFirst &&
        seen !== null &&
        body.unread > 0 &&
        soundEnabled(window.localStorage)
      ) {
        const played = await notificationSound.play();
        setAudioBlocked(!played);
      }
    } catch {
      // A failed poll is not worth telling anyone about; the next one is fifteen seconds away.
    }
  }, [authFetch, me.membershipId]);

  useEffect(() => {
    void refreshCount();
    const timer = window.setInterval(() => void refreshCount(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [refreshCount]);

  /** Closing on an outside click, so the panel does not sit over the screen behind it. */
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent): void => {
      if (
        panel.current !== null &&
        !panel.current.contains(event.target as Node)
      )
        setOpen(false);
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
      const [response, pausedResponse] = await Promise.all([
        authFetch("/api/notifications"),
        // Chats the assistant is paused on. A failure here only hides that section.
        authFetch("/api/whatsapp/handoffs").catch(() => null),
      ]);
      if (response.ok)
        setItems(
          ((await response.json()) as { items: NotificationItem[] }).items,
        );
      if (pausedResponse?.ok)
        setPaused(
          ((await pausedResponse.json()) as { items: PausedChat[] }).items,
        );
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

  async function resumeBot(conversationId: string): Promise<void> {
    const response = await authFetch(
      `/api/whatsapp/handoffs/${conversationId}/resume`,
      { method: "POST" },
    );
    if (response.ok)
      setPaused((current) =>
        current.filter((chat) => chat.conversationId !== conversationId),
      );
  }
  function toggleSound(): void {
    const next = !sound;
    setSound(next);
    setSoundEnabled(window.localStorage, next);
    if (next) {
      notificationSound.unlock();
      void notificationSound.play().then((played) => setAudioBlocked(!played));
    } else {
      setAudioBlocked(false);
    }
  }

  const time = new Intl.DateTimeFormat(intlLocale(locale), {
    timeZone: "Africa/Cairo",
    dateStyle: "short",
    timeStyle: "short",
    hour12: false,
  });

  const clock = new Intl.DateTimeFormat(intlLocale(locale), {
    timeZone: "Africa/Cairo",
    timeStyle: "short",
    hour12: false,
  });

  return (
    <div className="relative flex items-center" ref={panel}>
      <button
        type="button"
        aria-label={
          unread > 0
            ? `${t("notifications.open")} (${unread})`
            : t("notifications.open")
        }
        aria-expanded={open}
        onClick={() => void toggle()}
        className="relative inline-flex size-10 items-center justify-center rounded-lg text-ink-muted transition-colors hover:bg-primary-soft hover:text-primary"
      >
        <Bell size={22} strokeWidth={1.75} aria-hidden="true" />
        {unread > 0 && (
          <span className="numeric absolute -top-0.5 -inset-e-0.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-danger px-1 text-[11px] font-medium text-white">
            {unread > 99 ? "99+" : unread}
          </span>
        )}
      </button>

      {audioBlocked && (
        <div
          role="alert"
          className="absolute inset-e-0 top-full z-30 mt-1 w-[min(18rem,calc(100vw-1.5rem))] rounded-lg border border-border bg-warning-soft px-3 py-2 text-xs text-warning"
        >
          {t("notifications.sound.blocked")}
          <button
            type="button"
            className="ms-2 underline"
            onClick={() => {
              notificationSound.unlock();
              void notificationSound
                .play()
                .then((played) => setAudioBlocked(!played));
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
        <div className="absolute inset-e-0 top-full z-20 mt-2 w-[min(20rem,calc(100vw-1.5rem))] rounded-xl border border-border bg-surface shadow-lg">
          <div className="flex items-center justify-between border-b border-border px-3 py-2">
            <span className="text-sm font-semibold">
              {t("notifications.title")}
            </span>
            {items.some((item) => !item.read) && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void markAllRead()}
              >
                {t("notifications.markAllRead")}
              </Button>
            )}
          </div>

          <button
            type="button"
            role="switch"
            aria-checked={sound}
            onClick={toggleSound}
            className="flex w-full items-center gap-2 border-b border-border px-3 py-2 text-sm text-ink-muted hover:bg-surface-sunken"
          >
            {sound ? (
              <Volume2
                size={16}
                aria-hidden="true"
                className="shrink-0 text-primary"
              />
            ) : (
              <VolumeX size={16} aria-hidden="true" className="shrink-0" />
            )}
            {sound ? t("notifications.sound.on") : t("notifications.sound.off")}
          </button>

          {paused.length > 0 && (
            <div className="border-b border-border">
              <p className="px-3 pt-2 text-xs font-semibold text-ink-muted">
                {t("notifications.handoff.title")}
              </p>
              <ul>
                {paused.map((chat) => (
                  <li
                    key={chat.conversationId}
                    className="flex items-center gap-2 px-3 py-2"
                  >
                    <div className="min-w-0 flex-1">
                      <p
                        dir="ltr"
                        className="truncate text-start text-sm text-ink"
                      >
                        {chat.phone}
                      </p>
                      <p className="text-[11px] text-ink-muted">
                        {t("notifications.handoff.until")}{" "}
                        {clock.format(new Date(chat.pausedUntil))}
                      </p>
                    </div>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => void resumeBot(chat.conversationId)}
                    >
                      {t("notifications.handoff.resume")}
                    </Button>
                  </li>
                ))}
              </ul>
            </div>
          )}
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
                  {item.payload.patientName ?? item.payload.phone ?? ""}
                  {item.payload.start !== undefined &&
                    ` · ${time.format(new Date(item.payload.start))}`}
                  {item.payload.referenceNumber !== undefined &&
                    ` · ${item.payload.referenceNumber}`}
                </p>

                {item.payload.reason != null && item.payload.reason !== "" && (
                  <p className="text-xs text-ink-muted">
                    {item.payload.reason}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
