/**
 * Interface language: the value domain, the untrusted-input boundary, and the resolution chain.
 * SCHEMA-DECISIONS.md D20.
 *
 * **This module touches nothing.** No `window`, no `localStorage`, no `document`, no imports from
 * anywhere else in the app. That is deliberate for two reasons. It is the same purity rule as
 * `modules/appointments/domain/` and `modules/patients/domain/` on the API side (CLAUDE.md), and
 * it is what lets these rules be tested at all: `apps/web` has no test runner of its own, and
 * adding one would be a new dependency, so the specs live in the API's Jest suite and import this
 * file directly. A single `document` reference here would end that.
 *
 * The DOM half lives in `locale-store.ts`, which is a thin adapter over this.
 */

/** The supported interface languages. Mirrors the CHECK on `users.locale` and `tenants.locale`. */
export const LOCALES = ["ar", "en"] as const;

export type Locale = (typeof LOCALES)[number];

/** Text direction is *derived*, never stored — D20. Persisting it lets the two drift apart. */
export type Direction = "rtl" | "ltr";

/** The `localStorage` key holding the cached locale. Also duplicated in index.html — see below. */
export const LOCALE_STORAGE_KEY = "clinic-os.locale";

export const DEFAULT_LOCALE: Locale = "ar";

/**
 * Narrows an untrusted value to a supported locale, or `null`.
 *
 * Everything reaching this is untrusted in the ordinary sense: `localStorage` is hand-editable and
 * outlives deploys, a URL parameter is whatever someone typed, and a database column can be older
 * than the constraint that now guards it. An unrecognised value must never reach the direction
 * stamp — a document in an undefined direction is not a cosmetic failure, it is an unreadable page.
 *
 * Deliberately strict: `"AR"`, `"en-GB"`, `"arabic"` and `" ar"` are all rejected rather than
 * coerced. Accepting `"en-GB"` by taking its prefix would mean a value the database would refuse
 * is nonetheless honoured by the UI, and the two would disagree about what the user chose.
 */
export function parseLocale(value: unknown): Locale | null {
  return typeof value === "string" && (LOCALES as readonly string[]).includes(value) ? (value as Locale) : null;
}

/** Direction for a locale. Arabic is the only right-to-left language this product supports. */
export function directionFor(locale: Locale): Direction {
  return locale === "ar" ? "rtl" : "ltr";
}

/**
 * The candidate values available when resolving a locale. Every field is untrusted and optional;
 * `resolveLocale` narrows each one and skips whatever does not survive.
 */
export interface LocaleSources {
  /** An explicit `?lang=` override. Highest precedence — it is a deliberate act. */
  url?: unknown;
  /** The cached value read before first paint. A bootstrap hint, not a preference — see below. */
  cached?: unknown;
  /** `users.locale`. Null or absent means "no override, follow the tenant" (D20). */
  user?: unknown;
  /** `tenants.locale`. Always present once a tenant is known. */
  tenant?: unknown;
}

/**
 * Resolves the interface language.
 *
 * **Before authentication** only `url` and `cached` exist, and the cache is the sole reason the
 * login page can paint in the right direction at all.
 *
 * **After authentication the user row wins over the cache**, and that inversion is the whole point
 * of D20's reconciliation subsection. The cache is a bootstrap hint: it exists because direction
 * must be stamped before first paint and a database value arrives too late. Treating it as
 * authoritative past that moment leaks one person's language into the next person's session on a
 * shared reception workstation — the case that survives *without* a logout, which clearing the
 * cache on logout cannot cover and which makes that clearing look like it is working.
 *
 * The cost is one visible transition, on a different screen after a full navigation, only on a
 * machine where somebody did not log out. It self-heals: the caller writes the resolved value back
 * to the cache.
 */
export function resolveLocale(sources: LocaleSources): Locale {
  const fromUrl = parseLocale(sources.url);
  if (fromUrl !== null) return fromUrl;

  const fromUser = parseLocale(sources.user);
  const fromTenant = parseLocale(sources.tenant);

  // Authenticated: the session's own values decide, and the cache is ignored entirely.
  if (fromUser !== null) return fromUser;
  if (fromTenant !== null) return fromTenant;

  // Unauthenticated: the cache is all there is.
  return parseLocale(sources.cached) ?? DEFAULT_LOCALE;
}

/**
 * True once a session is established — i.e. once `resolveLocale` will ignore the cache.
 *
 * Exported so the caller knows when to write the resolved value back and correct a stale cache,
 * rather than inferring it by comparing two locales and getting it wrong when they happen to match.
 */
export function hasSessionLocale(sources: LocaleSources): boolean {
  return parseLocale(sources.user) !== null || parseLocale(sources.tenant) !== null;
}
