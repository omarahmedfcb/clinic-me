// The pure half of subscription expiry: no database, so platform-clinics.ts and subscription.ts can
// both import it without importing each other.

/**
 * Written to `tenants.suspension_reason` by the expiry job. The console and the sign-in screen
 * recognise an expiry by this exact value, and `user_has_expired_subscription()` (SQL) matches it
 * too -- change one, change both.
 */
export const SUBSCRIPTION_EXPIRED_REASON = "SUBSCRIPTION_EXPIRED";

/** `YYYY-MM-DD` of `now` in the given IANA zone. An unknown zone falls back to UTC. */
export function localDay(now: Date, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

/** Past its last working day: the date is strictly before today in the clinic's own zone. */
export function isSubscriptionExpired(renewalOn: string, now: Date, timeZone: string): boolean {
  return renewalOn < localDay(now, timeZone);
}

/** The in-app banner opens this many days before the last working day. Matches the console's own window. */
export const SUBSCRIPTION_NOTICE_DAYS = 14;

/** Whole days from today (in the clinic's zone) to the last working day; 0 on the last day itself. */
export function daysLeft(renewalOn: string, now: Date, timeZone: string): number {
  const DAY = 24 * 60 * 60 * 1000;
  return Math.round((Date.parse(`${renewalOn}T00:00:00Z`) - Date.parse(`${localDay(now, timeZone)}T00:00:00Z`)) / DAY);
}

// ---------------------------------------------------------------------------------------------
// The subscription range: [startsOn, endsOn], both days inclusive, in the clinic's own timezone.
// ---------------------------------------------------------------------------------------------

/**
 * Where a clinic stands against its range today.
 *   NONE         no range at all -- the bot stays silent.
 *   NOT_STARTED  the range begins in the future -- the bot stays silent until that day.
 *   RUNNING      today is inside the range.
 *   ENDED        the last day has passed -- the clinic is suspended (subscription.ts).
 * A legacy file with an end day and no start day counts as started: it only ever had an end.
 */
export type SubscriptionPhase = "NONE" | "NOT_STARTED" | "RUNNING" | "ENDED";

export function subscriptionPhase(
  startsOn: string | null,
  endsOn: string | null,
  now: Date,
  timeZone: string,
): SubscriptionPhase {
  if (endsOn === null) return "NONE";
  const today = localDay(now, timeZone);
  if (endsOn < today) return "ENDED";
  if (startsOn !== null && today < startsOn) return "NOT_STARTED";
  return "RUNNING";
}

/** The bot is silent exactly when there is no range yet, or it has not begun. */
export const botIsPausedIn = (phase: SubscriptionPhase): boolean => phase === "NONE" || phase === "NOT_STARTED";

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** `day` moved by `days` calendar days. Works on the date alone, so no timezone can shift it. */
export function addDays(day: string, days: number): string {
  const moved = new Date(Date.parse(`${day}T00:00:00Z`) + days * 24 * 60 * 60 * 1000);
  return moved.toISOString().slice(0, 10);
}

export type SubscriptionPlan =
  | { ok: true; startsOn: string; endsOn: string }
  | {
      ok: false;
      code: "INVALID_DATE_RANGE" | "DATE_IN_PAST" | "SUBSCRIPTION_GAP";
      field: "subscriptionStartsOn" | "renewalOn";
    };

/**
 * The range a clinic ends up with after the operator enters `input`, or the reason it is refused.
 *
 * - Neither date may be before today in the clinic's zone, and the end may not precede the start.
 * - A range that overlaps or touches the current one is merged with it: the earliest start and the
 *   latest end win, so a renewal entered early simply extends the subscription.
 * - A range that leaves a gap after a subscription that is still running (or has not started) is
 *   refused. After a subscription that has already ENDED, or with none, the new range replaces it:
 *   the lapse was a lapse.
 */
export function planSubscription(
  current: { startsOn: string | null; endsOn: string | null },
  input: { startsOn: string; endsOn: string },
  now: Date,
  timeZone: string,
): SubscriptionPlan {
  if (!ISO_DAY.test(input.startsOn)) return { ok: false, code: "INVALID_DATE_RANGE", field: "subscriptionStartsOn" };
  if (!ISO_DAY.test(input.endsOn)) return { ok: false, code: "INVALID_DATE_RANGE", field: "renewalOn" };

  const today = localDay(now, timeZone);
  if (input.startsOn < today) return { ok: false, code: "DATE_IN_PAST", field: "subscriptionStartsOn" };
  if (input.endsOn < today) return { ok: false, code: "DATE_IN_PAST", field: "renewalOn" };
  if (input.endsOn < input.startsOn) return { ok: false, code: "INVALID_DATE_RANGE", field: "renewalOn" };

  const phase = subscriptionPhase(current.startsOn, current.endsOn, now, timeZone);
  if (phase === "NONE" || current.endsOn === null) return { ok: true, startsOn: input.startsOn, endsOn: input.endsOn };

  const currentStart = current.startsOn ?? input.startsOn;
  const touchesOrOverlaps =
    input.startsOn <= addDays(current.endsOn, 1) && addDays(input.endsOn, 1) >= currentStart;

  if (touchesOrOverlaps) {
    return {
      ok: true,
      startsOn: input.startsOn < currentStart ? input.startsOn : currentStart,
      endsOn: input.endsOn > current.endsOn ? input.endsOn : current.endsOn,
    };
  }
  if (phase === "ENDED") return { ok: true, startsOn: input.startsOn, endsOn: input.endsOn };
  return { ok: false, code: "SUBSCRIPTION_GAP", field: "subscriptionStartsOn" };
}
