// Every date and time this suite formats is checked for Arabic-Indic digits — the founder's ruling
// of 2026-09-12. Registered globally, so a new screen cannot miss it and no spec has to opt in.

import { afterEach, beforeEach } from "vitest";

/** Arabic-Indic (٠-٩) and Extended Arabic-Indic (۰-۹). Latin digits are what clinics read here. */
const ARABIC_INDIC = /[٠-٩۰-۹]/;

let violations: string[] = [];

/**
 * **The formatters are watched, not the DOM.**
 *
 * The first version of this swept every rendered node and failed on twelve passing specs — all of
 * them rendering `"١٢ شارع الجمهورية، القاهرة"`, a clinic's own address as somebody typed it.
 * Stored text is echoed back byte-identical in this codebase and must be: a guard that cannot tell
 * a formatted date from a user's own words would either be switched off or would start rewriting
 * their data. The rule is about what *this app formats*, so that is what is instrumented — which
 * also reports the call that produced the wrong digits rather than the screen it landed on.
 */
function watch<T extends (...args: never[]) => unknown>(label: string, original: T): T {
  return function patched(this: unknown, ...args: never[]): unknown {
    const output = original.apply(this, args);
    if (typeof output === "string" && ARABIC_INDIC.test(output)) {
      violations.push(`${label} produced "${output}"`);
    }
    return output;
  } as unknown as T;
}

const DATE_PROTO = Date.prototype;
DATE_PROTO.toLocaleDateString = watch("toLocaleDateString", DATE_PROTO.toLocaleDateString);
DATE_PROTO.toLocaleTimeString = watch("toLocaleTimeString", DATE_PROTO.toLocaleTimeString);
DATE_PROTO.toLocaleString = watch("toLocaleString", DATE_PROTO.toLocaleString);

/**
 * The constructor is wrapped, not `prototype.format`: that is an accessor returning a bound
 * function, and reading it off the prototype throws `called on incompatible receiver`.
 */
const OriginalDateTimeFormat = Intl.DateTimeFormat;
const PatchedDateTimeFormat = function DateTimeFormat(this: unknown, ...args: unknown[]) {
  const instance = new (OriginalDateTimeFormat as unknown as new (...a: unknown[]) => Intl.DateTimeFormat)(
    ...args,
  );
  // `defineProperty`, not assignment: `format` is a getter with no setter, so `=` throws in strict
  // mode — which every ES module is.
  Object.defineProperty(instance, "format", {
    value: watch("Intl.DateTimeFormat#format", instance.format.bind(instance)),
    configurable: true,
    writable: true,
  });
  return instance;
} as unknown as typeof Intl.DateTimeFormat;
Object.defineProperty(PatchedDateTimeFormat, "prototype", {
  value: OriginalDateTimeFormat.prototype,
});
PatchedDateTimeFormat.supportedLocalesOf = OriginalDateTimeFormat.supportedLocalesOf;
Intl.DateTimeFormat = PatchedDateTimeFormat;

beforeEach(() => {
  violations = [];
});

afterEach(() => {
  if (violations.length === 0) return;
  const seen = [...new Set(violations)].slice(0, 5).join("\n  ");
  violations = [];
  throw new Error(
    `A date or time was formatted with Arabic-Indic digits:\n  ${seen}\n` +
      "Build the formatter from intlLocale(locale) — it carries -u-nu-latn — rather than from a " +
      "bare, browser-default or hardcoded locale.",
  );
});
