// Rendering a refusal into a sentence. Split out because three screens need it and because the
// `field` param has to be translated rather than interpolated raw.

import type { TranslationKey } from "../../i18n/strings.ts";

/**
 * The sentence for a refusal, with its params filled in.
 *
 * **`field` is looked up, not printed.** The server sends a DTO property name — `slug`,
 * `adminPhone` — and putting that into an Arabic sentence would read as `تحقّق من خانة «slug»`.
 * The client owns the noun, exactly as it owns `resource` for `NOT_FOUND`; the API conformance spec
 * fails the build when a field name has no Arabic.
 */
export function refusalText(
  t: (key: TranslationKey) => string,
  code: string,
  params: Record<string, unknown>,
): string {
  const readable = (key: string, value: unknown): string => {
    if (key === "field") {
      const name = typeof value === "string" ? value : "unknown";
      const translated = t(`field.${name}` as TranslationKey);
      // `t` renders the key itself when nothing is registered, which would put `field.foo` in front
      // of a person. The generic noun is a worse sentence and a better one than that.
      return translated === `field.${name}` ? t("field.unknown") : translated;
    }
    return String(value);
  };

  return Object.entries(params).reduce(
    (text, [key, value]) => text.replaceAll(`{${key}}`, readable(key, value)),
    t(`refusal.${code}` as TranslationKey),
  );
}
