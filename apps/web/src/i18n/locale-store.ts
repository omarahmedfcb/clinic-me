import {
  DEFAULT_LOCALE,
  directionFor,
  hasSessionLocale,
  LOCALE_STORAGE_KEY,
  type Locale,
  type LocaleSources,
  parseLocale,
  resolveLocale,
} from "./locale.ts";

/**
 * The DOM half of interface-language handling (D20): reading and writing the cached locale, and
 * stamping direction onto the document.
 *
 * Kept separate from `locale.ts` so the rules stay testable without a browser — `apps/web` has no
 * test runner and adding one would be a new dependency, so the specs import the pure module from
 * the API's Jest suite.
 */

/**
 * The subset of `Storage` this needs, declared rather than imported from `lib.dom`.
 *
 * Not squeamishness about DOM types: it is what lets a test pass a fake in, and what documents
 * that the only three operations performed on a viewer's browser storage are these three.
 */
export interface LocaleStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * Reads the cached locale. Returns `null` for anything unrecognised rather than the raw string, so
 * a hand-edited or stale value cannot reach the direction stamp.
 *
 * Every access is wrapped: `localStorage` throws outright in some contexts — a private window with
 * site data blocked, an embedded viewer, a browser configured to refuse storage — and a language
 * preference is never worth failing a page load over.
 */
export function readCachedLocale(store: LocaleStore): Locale | null {
  try {
    return parseLocale(store.getItem(LOCALE_STORAGE_KEY));
  } catch {
    return null;
  }
}

/** Caches a locale so the *next* first paint can stamp direction before anything renders. */
export function writeCachedLocale(store: LocaleStore, locale: Locale): void {
  try {
    store.setItem(LOCALE_STORAGE_KEY, locale);
  } catch {
    // Storage unavailable. The app still works; the next first paint just falls back to Arabic.
  }
}

/**
 * Clears the cached locale. **Called on logout, and that is not optional.**
 *
 * Reception commonly shares one workstation and one browser profile. Without this, a doctor's
 * English preference persists into whoever logs in next (D20). It is the tidy half of the problem —
 * the untidy half, where no logout happens at all, is handled by `resolveLocale` preferring the
 * user row over the cache once a session exists. Neither covers the other, and removing either one
 * leaves a leak that the remaining one makes look fixed.
 */
export function clearCachedLocale(store: LocaleStore): void {
  try {
    store.removeItem(LOCALE_STORAGE_KEY);
  } catch {
    // Nothing to do: if storage is unreachable there is also nothing cached to leak.
  }
}

/**
 * Applies a locale to the document: `lang`, `dir`, and the cache for next time.
 *
 * `dir` is derived from the locale every time and never read back from the DOM, so the two cannot
 * drift — the failure D20 rules out by refusing to persist direction as its own field.
 */
export function applyLocale(documentElement: { lang: string; dir: string }, store: LocaleStore, locale: Locale): void {
  documentElement.lang = locale;
  documentElement.dir = directionFor(locale);
  writeCachedLocale(store, locale);
}

/**
 * Resolves the locale for the current moment and applies it.
 *
 * Writes back whenever a session exists, which is what corrects a stale cache left by whoever used
 * the machine last. Before login there is no authority to correct it against, so the cache is left
 * exactly as found.
 */
export function settleLocale(
  documentElement: { lang: string; dir: string },
  store: LocaleStore,
  sources: Omit<LocaleSources, "cached">,
): Locale {
  const locale = resolveLocale({ ...sources, cached: readCachedLocale(store) });
  documentElement.lang = locale;
  documentElement.dir = directionFor(locale);
  if (hasSessionLocale(sources)) writeCachedLocale(store, locale);
  return locale;
}

export { DEFAULT_LOCALE, LOCALE_STORAGE_KEY };
