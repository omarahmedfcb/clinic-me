/**
 * The notification sound, and the browser policy that makes it awkward.
 *
 * ## Why this is more than `new Audio().play()`
 *
 * Browsers block audio until the page has been interacted with, and `play()` signals that by
 * returning a **rejected promise** — which most code ignores, so the failure is silent. The alert
 * at risk is therefore the first one of the day, which is the worst one to lose.
 *
 * Three parts, and the first is what makes the rest acceptable:
 *
 * 1. **Sound is never the notification.** The badge and the count are. Sound is an accelerator, so
 *    a blocked `play()` costs speed and nothing else.
 * 2. **Unlock at login**, which is a guaranteed user gesture at exactly the moment reception needs
 *    it — they sign in once at the start of the day.
 * 3. **Report a rejection.** The caller shows a banner. A clinic that believes it will be alerted
 *    and is not is worse off than one that knows sound is off.
 *
 * ## Off by default, and per device
 *
 * Reception is a shared, quiet, public-facing room. A system that starts making noise on a
 * stranger's desk is one they resent before they trust it.
 *
 * The preference is per **device**, in `localStorage`, not per user on the server: whether sound is
 * appropriate depends on the room the browser is in, and the same receptionist wants sound at the
 * front desk and silence on a laptop in a consulting room. A server-side preference would follow
 * them into the wrong room.
 */

const STORAGE_KEY = "clinic-os.notifications.sound";

/** Read the per-device preference. Absent, unreadable or unrecognised all mean OFF. */
export function soundEnabled(storage: Storage): boolean {
  try {
    return storage.getItem(STORAGE_KEY) === "on";
  } catch {
    // Private window, blocked site data, an embedded viewer. Silence is the safe default.
    return false;
  }
}

export function setSoundEnabled(storage: Storage, enabled: boolean): void {
  try {
    storage.setItem(STORAGE_KEY, enabled ? "on" : "off");
  } catch {
    // Nothing to do: the toggle still works for this session, it just will not be remembered.
  }
}
