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
