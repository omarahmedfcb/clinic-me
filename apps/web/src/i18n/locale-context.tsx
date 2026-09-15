import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { DEFAULT_LOCALE, directionFor, type Locale } from "./locale.ts";
import { readCachedLocale, writeCachedLocale } from "./locale-store.ts";
import { translate, type TranslationKey } from "./strings.ts";

/**
 * Makes the interface language reactive.
 *
 * The module-level `t` in strings.ts is bound to Arabic at import time, which is correct for code
 * that runs before a locale is known and useless for a switcher — pressing it would change the
 * document direction and leave every string in the language it started in.
 *
 * The initial value comes from the same cache the pre-paint stamp in index.html reads, so the first
 * render agrees with the direction already on the document. Once a session exists the user row wins
 * and overwrites this (SCHEMA-DECISIONS.md D20); there is no session on the login screen, so the
 * cache is the only signal and is left as found until the user changes it deliberately.
 */

interface LocaleContextValue {
  locale: Locale;
  setLocale: (next: Locale) => void;
  t: (key: TranslationKey) => string;
}

const LocaleContext = createContext<LocaleContextValue | undefined>(undefined);

/** Reads the cached locale through the same guard the stamp uses, so a corrupt value cannot land. */
function initialLocale(): Locale {
  return readCachedLocale(safeStorage()) ?? DEFAULT_LOCALE;
}

/**
 * `localStorage` throws outright in some contexts — a private window with site data blocked, an
 * embedded viewer. The store adapter already wraps each call, but reaching for the object itself
 * can throw, so that is guarded here rather than at every call site.
 */
function safeStorage(): Storage {
  try {
    return window.localStorage;
  } catch {
    return {
      getItem: () => null,
      setItem: () => undefined,
      removeItem: () => undefined,
    } as unknown as Storage;
  }
}

export function LocaleProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(initialLocale);

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next);
    // Direction is derived, never stored (D20). Applied to the document here so the change is a
    // single act rather than a state update the layout has to catch up with.
    document.documentElement.lang = next;
    document.documentElement.dir = directionFor(next);
    writeCachedLocale(safeStorage(), next);
  }, []);

  const value = useMemo<LocaleContextValue>(
    () => ({ locale, setLocale, t: (key) => translate(locale, key) }),
    [locale, setLocale],
  );

  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

export function useLocale(): LocaleContextValue {
  const value = useContext(LocaleContext);
  if (value === undefined) {
    throw new Error("useLocale() outside a <LocaleProvider>. Wrap the tree in main.tsx.");
  }
  return value;
}
