import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { stripComments } from "../../scripts/route-capabilities.ts";
import { ALL_APPOINTMENT_STATUSES } from "../../../web/src/domain/appointment-status.ts";
import { formatMinor, intlLocale } from "../../../web/src/i18n/format.ts";
import {
  DEFAULT_LOCALE,
  directionFor,
  LOCALE_STORAGE_KEY,
  LOCALES,
  type Locale,
  parseLocale,
  resolveLocale,
} from "../../../web/src/i18n/locale.ts";
import {
  clearCachedLocale,
  type LocaleStore,
  readCachedLocale,
  settleLocale,
} from "../../../web/src/i18n/locale-store.ts";
import {
  ALL_TRANSLATION_KEYS,
  missingKeys,
  translate,
  type TranslationKey,
} from "../../../web/src/i18n/strings.ts";

/**
 * Interface-language plumbing (SCHEMA-DECISIONS.md D20).
 *
 * These live in the API's Jest project because `apps/web` has no test runner and adding one would
 * be a new dependency — the same arrangement as `web-logical-properties.spec.ts`. It works because
 * `web/src/i18n/locale.ts` and `strings.ts` touch no DOM at all, and `locale-store.ts` declares the
 * three storage operations it needs rather than importing `lib.dom`.
 */

/** A `localStorage` stand-in. `throws` reproduces a private window or blocked site data. */
function fakeStore(initial?: string, options?: { throws?: boolean }): LocaleStore & { value: string | null } {
  return {
    value: initial ?? null,
    getItem(key) {
      if (options?.throws) throw new Error("storage unavailable");
      return key === LOCALE_STORAGE_KEY ? this.value : null;
    },
    setItem(key, value) {
      if (options?.throws) throw new Error("storage unavailable");
      if (key === LOCALE_STORAGE_KEY) this.value = value;
    },
    removeItem(key) {
      if (options?.throws) throw new Error("storage unavailable");
      if (key === LOCALE_STORAGE_KEY) this.value = null;
    },
  };
}

const fakeDocument = (): { lang: string; dir: string } => ({ lang: "ar", dir: "rtl" });

describe("locale value domain", () => {
  test("accepts exactly the two supported locales", () => {
    for (const locale of LOCALES) expect(parseLocale(locale)).toBe(locale);
  });

  test("rejects anything else, rather than coercing it", () => {
    // "en-GB" is the tempting one to accept by prefix. Doing so would honour in the UI a value the
    // database CHECK refuses, and the two would then disagree about what the user chose.
    for (const invalid of ["AR", "EN", "arabic", "en-GB", " ar", "", null, undefined, 7, {}, ["ar"]]) {
      expect({ invalid, parsed: parseLocale(invalid) }).toEqual({ invalid, parsed: null });
    }
  });

  test("direction is derived, never stored", () => {
    expect(directionFor("ar")).toBe("rtl");
    expect(directionFor("en")).toBe("ltr");
  });
});

describe("resolution chain", () => {
  test("an explicit URL override wins over everything", () => {
    expect(resolveLocale({ url: "en", cached: "ar", user: "ar", tenant: "ar" })).toBe("en");
  });

  test("before login the cache is the only signal", () => {
    expect(resolveLocale({ cached: "en" })).toBe("en");
    expect(resolveLocale({})).toBe(DEFAULT_LOCALE);
  });

  test("the user row beats the tenant default", () => {
    expect(resolveLocale({ user: "en", tenant: "ar" })).toBe("en");
  });

  test("a user with no override follows the tenant", () => {
    // users.locale is nullable precisely so this case exists (D20). null must not read as "ar".
    expect(resolveLocale({ user: null, tenant: "en" })).toBe("en");
  });

  test("falls back to Arabic when nothing resolves", () => {
    expect(resolveLocale({ url: "fr", cached: "AR", user: "arabic", tenant: "" })).toBe("ar");
  });
});

describe("the cache cannot govern a session", () => {
  test("LOGOUT: clearing the cache stops a preference reaching the next person", () => {
    // Reception shares one workstation and one browser profile. This is the tidy half of the
    // problem -- see the next test for the half this cannot cover.
    const store = fakeStore("en");
    expect(readCachedLocale(store)).toBe("en");

    clearCachedLocale(store);

    expect(readCachedLocale(store)).toBeNull();
    expect(resolveLocale({ cached: readCachedLocale(store) })).toBe(DEFAULT_LOCALE);
  });

  test("UNCLEAN EXIT: a stale cache with no logout does not govern the next user's shell", () => {
    // The case the logout clear structurally cannot cover: a browser crash, a closed tab, an
    // expired session. The cache still says "en" from the previous user, and a different user now
    // logs in whose row says "ar". If the cache won here, clearing on logout would look like it
    // was working while this path leaked -- a partial guarantee that looks total.
    const store = fakeStore("en");
    const documentElement = fakeDocument();

    const resolved = settleLocale(documentElement, store, { user: "ar", tenant: "en" });

    expect(resolved).toBe("ar");
    expect(documentElement.dir).toBe("rtl");
    // And it self-heals: the stale value is corrected, so the next first paint is right too.
    expect(store.value).toBe("ar");
  });

  test("before login the cache is left exactly as found, having nothing to correct it against", () => {
    const store = fakeStore("en");
    const documentElement = fakeDocument();

    expect(settleLocale(documentElement, store, {})).toBe("en");
    expect(documentElement.dir).toBe("ltr");
    expect(store.value).toBe("en");
  });

  test("a corrupted cached value cannot put the document in an undefined direction", () => {
    for (const corrupt of ["rtl", "EN", "{}", "ar en", " "]) {
      const documentElement = fakeDocument();
      expect(settleLocale(documentElement, fakeStore(corrupt), {})).toBe("ar");
      expect(documentElement.dir).toBe("rtl");
    }
  });

  test("storage that throws does not break the page", () => {
    // A private window, blocked site data, an embedded viewer. A language preference is never
    // worth failing a page load over.
    const documentElement = fakeDocument();
    expect(() => settleLocale(documentElement, fakeStore("en", { throws: true }), { user: "en" })).not.toThrow();
    expect(documentElement.dir).toBe("ltr");
  });
});

describe("the pre-paint stamp in index.html", () => {
  // The inline script duplicates the allowed values and the storage key, because plain script in
  // HTML cannot import the module that owns them. Rather than trust that the copy stays in step,
  // it is extracted and run against the same inputs as parseLocale().
  const html = readFileSync(path.resolve(__dirname, "..", "..", "..", "web", "index.html"), "utf8");

  function runStamp(cached: string | null): { lang: string; dir: string } {
    const match = /<script>([\s\S]*?)<\/script>/.exec(html);
    if (match?.[1] === undefined) {
      throw new Error(
        "index.html no longer contains an inline <script>. The pre-paint direction stamp is what " +
          "makes RTL correct on the first frame (D20). Do not delete this test to go green.",
      );
    }
    const documentElement = { lang: "ar", dir: "rtl" };
    const window = { localStorage: { getItem: (key: string) => (key === LOCALE_STORAGE_KEY ? cached : null) } };
    // eslint-disable-next-line no-new-func -- deliberate: running the shipped script is the point.
    new Function("window", "document", match[1])(window, { documentElement });
    return documentElement;
  }

  test("agrees with parseLocale() on every input, valid or not", () => {
    for (const input of ["ar", "en", "AR", "arabic", "en-GB", "", " ar", "rtl", null]) {
      const stamped = runStamp(input);
      const parsed = parseLocale(input);
      const expected = parsed ?? DEFAULT_LOCALE;
      expect({ input, lang: stamped.lang, dir: stamped.dir }).toEqual({
        input,
        lang: expected,
        dir: directionFor(expected),
      });
    }
  });

  test("reads the same storage key the application writes", () => {
    expect(html).toContain(`"${LOCALE_STORAGE_KEY}"`);
  });
});

describe("string catalogue", () => {
  test("Arabic covers every appointment status, so a new state cannot render as an identifier", () => {
    for (const status of ALL_APPOINTMENT_STATUSES) {
      const key = `appointment.status.${status}` as const;
      expect({ status, label: translate("ar", key) }).not.toEqual({ status, label: key });
    }
  });

  test("a missing string falls back to its key, never to the Arabic", () => {
    // Arabic text inside an English page looks like a rendering bug and gets reported as one; a
    // dotted key is unmistakably "nobody has written this yet".
    //
    // Both catalogues are complete, so this needs a key that is in neither. The cast is the point
    // of the test rather than a shortcut around it: it reproduces a key reaching translate() that
    // the catalogues do not have, which is what a half-added string looks like at runtime.
    const absent = "day.notAStringAnyoneWrote" as TranslationKey;
    expect(translate("en", absent)).toBe(absent);
    expect(translate("ar", absent)).toBe(absent);
    expect(missingKeys("ar")).toEqual([]);
  });

  test("English is complete, because the toggle is reachable from every screen", () => {
    // This assertion used to be narrower: English covered `login.`, `language.` and `shell.` only,
    // on the stated ground that "the language toggle lives on the login screen only". That ground
    // stopped being true when the toggle was added to the authenticated shell header, and the test
    // did not notice — it compared key sets, never where the toggle lived, so it kept passing while
    // the thing it described had changed underneath it. The day view was built, switched to
    // English, and rendered `day.title`, `day.fullyBooked.title` and eleven more raw keys.
    //
    // A partial catalogue is only safe while something structurally confines the toggle, and
    // nothing does. So the rule is now the simple one: the toggle is global, therefore English is
    // complete. Adding an Arabic string without its English counterpart fails here.
    expect(missingKeys("en")).toEqual([]);
    expect(ALL_TRANSLATION_KEYS.length).toBeGreaterThan(100);
  });

  test("every locale in LOCALES has a catalogue, even an empty one", () => {
    for (const locale of LOCALES) expect(() => translate(locale as Locale, "common.close")).not.toThrow();
  });
});

/**
 * Dates and times render Latin digits — the founder's ruling of 2026-09-12.
 *
 * `ar-EG` resolves to the `arab` numbering system, so every formatter built from it produces
 * ٢٠٢٦/٩/١٣ and ٠٩:٠٠ unless it says otherwise, and nothing fails until somebody looks at a screen.
 * He reported two; an audit found every date formatter in the app except one, across seventeen
 * files — so the fix is `intlLocale()` carrying `-u-nu-latn`, and this is what holds it there.
 *
 * Two layers, because neither catches the other's case. This one reads source, so it covers screens
 * that have no spec yet — which is how all seventeen got in. `apps/web/src/test-setup.ts` watches
 * the formatters at runtime in the web suite, which covers a locale built some way this cannot see.
 */
describe("Latin digits in every formatted date and time", () => {
  const ARABIC_INDIC = /[٠-٩۰-۹]/;
  const WEB = path.resolve(__dirname, "..", "..", "..", "web", "src");

  /**
   * Two deliberate exceptions, both non-localised on purpose and both already Latin-digit. Listed
   * rather than pattern-matched: "a literal locale is fine if it is an English one" is the kind of
   * rule that quietly permits the next mistake.
   */
  const ALLOWED: { file: string; snippet: string }[] = [
    // A build stamp is a machine fact, not interface text: it must read the same to everyone.
    { file: "features/auth/BuildStamp.tsx", snippet: 'toLocaleString("en-GB"' },
    // en-CA is used to derive a YYYY-MM-DD key, not to show a date to anybody.
    { file: "features/day-view/DayViewPage.tsx", snippet: 'new Intl.DateTimeFormat("en-CA"' },
  ];

  function sourceFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return sourceFiles(full);
      if (!/\.tsx?$/.test(entry.name) || /\.spec\.tsx?$/.test(entry.name)) return [];
      // The runtime guard spells the digits out, in its pattern and in its message.
      if (entry.name === "test-setup.ts") return [];
      return [full];
    });
  }

  const files = sourceFiles(WEB).map((full) => ({
    relative: path.relative(WEB, full).replace(/\\/g, "/"),
    text: stripComments(readFileSync(full, "utf8")),
  }));

  const offenders = (pattern: RegExp): string[] =>
    files.flatMap((file) =>
      file.text
        .split(/\r?\n/)
        .map((line, index) => ({ line, number: index + 1 }))
        .filter(
          ({ line }) =>
            pattern.test(line) &&
            !ALLOWED.some((entry) => entry.file === file.relative && line.includes(entry.snippet)),
        )
        .map(({ line, number }) => `${file.relative}:${number} ${line.trim()}`),
    );

  test("intlLocale carries the numbering system, in both languages", () => {
    const at = new Date("2026-09-13T09:00:00Z");
    for (const locale of LOCALES) {
      const date = new Intl.DateTimeFormat(intlLocale(locale as Locale), {
        year: "numeric",
        month: "numeric",
        day: "numeric",
        timeZone: "UTC",
      }).format(at);
      const time = new Intl.DateTimeFormat(intlLocale(locale as Locale), {
        hour: "2-digit",
        minute: "2-digit",
        timeZone: "UTC",
      }).format(at);

      expect(date).not.toMatch(ARABIC_INDIC);
      expect(time).not.toMatch(ARABIC_INDIC);
      // The date is still a date: a formatter returning nothing would also pass the line above.
      expect(date).toContain("2026");
      expect(time).toContain("09");
      expect(formatMinor(30_000, "EGP", locale as Locale)).not.toMatch(ARABIC_INDIC);
    }
  });

  test("no screen formats a date or time with the browser's locale", () => {
    // `toLocaleDateString()` and `toLocaleTimeString([])` ignore the language toggle entirely, and
    // bring Arabic-Indic digits back on an Arabic browser.
    expect(offenders(/\.toLocale(?:Date|Time)?String\(\s*(?:\)|\[\s*\])/)).toEqual([]);
  });

  test("no screen hardcodes a regional locale instead of asking intlLocale", () => {
    // A bare `"ar"` is the language itself and is compared against all over the app. What is
    // forbidden is a regional tag, which is only ever used to build a formatter.
    expect(offenders(/["'](?:ar|en)-[A-Z]{2}["']/).filter((hit) => !hit.startsWith("i18n/"))).toEqual([]);
  });

  test("every Intl formatter outside i18n takes its locale from intlLocale", () => {
    expect(
      offenders(/new Intl\.(?:DateTimeFormat|NumberFormat)\((?!intlLocale)/).filter(
        (hit) => !hit.startsWith("i18n/"),
      ),
    ).toEqual([]);
  });

  test("no hand-written string in the app's own source carries an Arabic-Indic digit", () => {
    // The same wrong digits by a different route, and the runtime guard cannot catch it: that
    // watches formatters, and this is a literal.
    //
    // The app's own text only. Stored data is echoed back byte-identical — a clinic may well type
    // its address with Arabic-Indic digits, and nothing here rewrites what they typed.
    expect(files.filter((file) => ARABIC_INDIC.test(file.text)).map((file) => file.relative)).toEqual([]);
  });
});
