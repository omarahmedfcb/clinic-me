import { useLocale } from "../../i18n/locale-context.tsx";

/**
 * The interface-language toggle. Two languages, so a button, not a dropdown.
 *
 * ## It shows the language you would switch TO, not the one you are in
 *
 * Reading `ع` while the page is in English means "press this for Arabic". The alternative — showing
 * the current language — is ambiguous on a two-item toggle: a user seeing `EN` on an English page
 * cannot tell whether it is a label or an offer. Showing the destination makes it an offer.
 *
 * That also means the button's own text is the one string that must NOT be translated into the
 * current language: `ع` is written in Arabic script while the page is English, on purpose.
 *
 * ## Placement
 *
 * `end-4` is the inline-end edge — the left in Arabic, the right in English, which is where the
 * founder asked for it in both directions. Written as a logical property rather than `left`/`right`
 * so it moves with the direction rather than needing a second rule (`web-logical-properties.spec.ts`
 * enforces that repo-wide).
 *
 * ## Placement, and the two variants
 *
 * On login it floats at the inline-end corner of an otherwise empty page. In the shell it sits in
 * the header row beside the other controls, so it takes `inline` and drops the positioning rather
 * than being duplicated — one button, one behaviour, two placements.
 *
 * ## Scope
 *
 * Login and the shell. The English catalogue covers exactly those two screens, so putting this
 * button anywhere else — the gallery, or a Phase 2 screen — would render raw keys.
 * `test/unit/web-locale.spec.ts` asserts the translated set, so extending it fails a test first.
 */
export function LanguageToggle({ inline = false }: { inline?: boolean } = {}) {
  const { locale, setLocale, t } = useLocale();
  const next = locale === "ar" ? "en" : "ar";

  return (
    <button
      type="button"
      onClick={() => setLocale(next)}
      // The accessible name says what the control does; the visible text is a bare language mark,
      // which a screen reader would otherwise announce as a stray letter.
      aria-label={t("language.toggle.label")}
      lang={next}
      className={
        (inline ? "" : "absolute top-4 end-4 ") +
        "rounded-lg border border-border bg-surface px-3 py-1.5 text-sm font-medium text-ink-muted transition-colors hover:bg-surface-sunken hover:text-ink"
      }
    >
      {next === "en" ? t("language.toggle.toEnglish") : t("language.toggle.toArabic")}
    </button>
  );
}
