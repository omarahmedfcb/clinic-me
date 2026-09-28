// Anti-spam for the WhatsApp webhook -- webchat-prototype.md's "start simple" scope: no queue, no
// Redis, one in-process debouncer and one in-process counter, both keyed on the sender's wa_id.
// A restart loses both, the same acceptable cost webchat-session.ts already accepts for its own
// in-memory state -- this is a spam guard, not a source of truth, and the source of truth
// (`messages.external_message_id`'s uniqueness, whatsapp-conversation.ts) is durable regardless.
//
// The design this replaces, sized down: ARCHITECTURE.md §11 wants a BullMQ queue in front of the AI
// so a burst never blocks the webhook handler itself and multiple messages from one sender coalesce
// into one GPT turn. Both benefits are approximated here without the infrastructure -- debouncing in
// a `setTimeout` rather than a queued job, and the webhook still ACKs in milliseconds regardless of
// whether the debounce is still running, because it never awaits the timer. Moving this to a real
// queue later is a change to *this file's* internals; nothing that calls it needs to change.

const DEBOUNCE_MS = 4_000;
const WINDOW_MS = 60_000;
/** GPT-consuming turns per minute, per sender. Generous for a real conversation (a booking rarely
 *  needs more than a handful of turns) and tight for a script or a panicking retry loop. */
const MAX_TURNS_PER_WINDOW = 12;
/** Below this, an over-limit sender does not get a second "please wait" reply -- one canned message
 *  per debounce window is a limit; one per message is its own kind of spam. */
const WARNING_COOLDOWN_MS = 30_000;

interface PendingBatch {
  texts: string[];
  timer: ReturnType<typeof setTimeout>;
}

const pending = new Map<string, PendingBatch>();
const turnTimestamps = new Map<string, number[]>();
const lastWarningAt = new Map<string, number>();

/**
 * Buffers one inbound message and calls `onSettled` once with everything the sender sent in the
 * quiet window that follows -- newline-joined, so a burst of five messages becomes one GPT turn
 * instead of five. Returns immediately; the webhook handler must not await this.
 */
export function debounceMessage(waId: string, text: string, onSettled: (combinedText: string) => void): void {
  const existing = pending.get(waId);
  if (existing) {
    clearTimeout(existing.timer);
    existing.texts.push(text);
  }

  const texts = existing?.texts ?? [text];
  const timer = setTimeout(() => {
    pending.delete(waId);
    onSettled(texts.join("\n"));
  }, DEBOUNCE_MS);

  pending.set(waId, { texts, timer });
}

export type SpamCheck = { allowed: true } | { allowed: false; shouldWarn: boolean };

/**
 * Whether this sender may spend another GPT turn right now. Call once per *debounced batch*, not
 * once per raw inbound message -- a burst that got coalesced above should count as the one turn it
 * will actually cost, not as however many messages arrived.
 *
 * `shouldWarn` is `false` on a sender who is already being told to slow down within the cooldown --
 * the caller should still skip GPT, just send nothing rather than repeat the same reply.
 */
export function checkSpamLimit(waId: string, now: number = Date.now()): SpamCheck {
  const recent = (turnTimestamps.get(waId) ?? []).filter((timestamp) => now - timestamp < WINDOW_MS);

  if (recent.length < MAX_TURNS_PER_WINDOW) {
    recent.push(now);
    turnTimestamps.set(waId, recent);
    return { allowed: true };
  }

  turnTimestamps.set(waId, recent);
  const lastWarning = lastWarningAt.get(waId) ?? 0;
  if (now - lastWarning < WARNING_COOLDOWN_MS) {
    return { allowed: false, shouldWarn: false };
  }
  lastWarningAt.set(waId, now);
  return { allowed: false, shouldWarn: true };
}

export const SPAM_LIMIT_REPLY =
  "معذرة، عدد الرسائل كبير في وقت قصير. من فضلك انتظر لحظة قبل إرسال رسالة أخرى.\n" +
  "Sorry, that's a lot of messages in a short time. Please wait a moment before sending another.";
