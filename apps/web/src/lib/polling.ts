/**
 * Poll intervals, both spelled out in one place.
 *
 * `PHASE-3.md` Q1 asks for exactly this: the queue's interval "next to the notification one, with
 * both spelled out, so the difference reads as a decision rather than a typo". Three seconds apart
 * in two different files would look like an oversight; three lines apart with the reason between
 * them does not.
 *
 * The interval is chosen by **what staleness costs on each screen**, not by what polling costs the
 * server:
 *
 * - A stale notification bell lags. Someone learns about a booking fifteen seconds late, which is
 *   annoying and nothing more.
 * - A stale queue makes **two people call the same patient**. It is also the screen with the
 *   highest chance of two staff acting at once, because it is the one everybody has open all day.
 *
 * Neither timer runs while the tab is hidden. That matters at least as much as the interval: a
 * backgrounded tab left overnight would otherwise poll 5,760 times to learn nothing.
 */

/** The queue board. Q1, ruled 2026-08-29. */
export const QUEUE_POLL_MS = 5_000;

/** The notification bell. Unchanged from Phase 2. */
export const NOTIFICATION_POLL_MS = 15_000;
