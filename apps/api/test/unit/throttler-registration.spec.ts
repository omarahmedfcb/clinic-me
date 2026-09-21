import { readFileSync } from "node:fs";
import path from "node:path";
import { ALL_THROTTLERS, THROTTLER_NAMES } from "../../src/common/throttlers.ts";
import {
  INTAKE_THROTTLER,
  PAYMENTS_THROTTLER,
  UPLOAD_THROTTLER,
} from "../../src/common/write-throttle.ts";
import {
  BOT_CREATE_PATIENT_THROTTLER,
  BOT_CREDENTIAL_THROTTLER,
  BOT_WRITE_THROTTLER,
} from "../../src/modules/bot/bot-throttle.ts";
import {
  IDENTIFIER_THROTTLER,
  IP_THROTTLER,
  PASSWORD_THROTTLER,
} from "../../src/modules/auth/auth-throttle.ts";
import { sourceFiles, stripComments } from "../../scripts/route-capabilities.ts";

/**
 * **A `@Throttle` naming a throttler nobody registered is not an error — it is a no-op.**
 *
 * Found on 2026-09-19 while writing 4b's test: `ThrottlerModule.forRoot()` is `@Global()`, so the
 * three modules that each called it did not compose — the last one won, and every name the others
 * defined stopped existing. Sixty-five patient creations in a row were accepted with the decorator
 * in place and the limit in the file.
 *
 * Nothing failed, because there is nothing to fail: the guard looks up a name it cannot find and
 * lets the request through. So the check has to be here.
 */
const API_SRC = path.resolve(__dirname, "..", "..", "src");

/** Every throttler name a route asks for, read from the source rather than from a list. */
function namesUsedInSource(): string[] {
  const used = new Set<string>();
  for (const file of sourceFiles(API_SRC, [".ts"])) {
    if (file.endsWith(".spec.ts")) continue;
    const text = stripComments(readFileSync(file, "utf8"));
    // Both spellings, because the codebase uses both: a literal inside `@Throttle({ "name": … })`
    // and a constant inside `@SkipThrottle({ [NAME]: … })` or `ThrottleOnly(NAME, …)`. A scan that
    // knew only one would report a clean result while missing half the call sites.
    // Key positions only. Matching every identifier inside the call instead picks up its
    // neighbours — `WRITE_THROTTLE_LIMITS.intake` is an argument, not the name of a bucket.
    for (const call of text.matchAll(/(?:@Throttle|@SkipThrottle)\(\{([\s\S]{0,300}?)\}\)/g)) {
      const keys = call[1] ?? "";
      for (const literal of keys.matchAll(/"([a-z][a-z-]+)"\s*:/g)) used.add(literal[1] as string);
      for (const constant of keys.matchAll(/\[\s*([A-Z][A-Z_]{3,})\s*\]\s*:/g)) used.add(constant[1] as string);
    }
    for (const call of text.matchAll(/ThrottleOnly\(\s*([A-Z][A-Z_]{3,})/g)) used.add(call[1] as string);
    // `skipAllExcept(A, B)` names the buckets a route keeps, which is the other way routes say it.
    for (const call of text.matchAll(/skipAllExcept\(([^)]*)\)/g)) {
      for (const constant of (call[1] ?? "").matchAll(/\b([A-Z][A-Z_]{3,})\b/g)) used.add(constant[1] as string);
    }
  }
  return [...used];
}

/**
 * Constant name → the value it holds, taken from the modules themselves rather than transcribed.
 * A map written out by hand here would be a second place the names live, free to drift from the
 * first — which is the shape of mistake this file is about.
 */
const CONSTANTS: Record<string, string> = {
  INTAKE_THROTTLER,
  PAYMENTS_THROTTLER,
  UPLOAD_THROTTLER,
  BOT_CREDENTIAL_THROTTLER,
  BOT_WRITE_THROTTLER,
  BOT_CREATE_PATIENT_THROTTLER,
  PASSWORD_THROTTLER,
  IDENTIFIER_THROTTLER,
  IP_THROTTLER,
};

describe("every throttler a route names is actually registered", () => {
  test("the names used in source all exist in ALL_THROTTLERS", () => {
    const missing = namesUsedInSource()
      .map((name) => CONSTANTS[name] ?? name)
      .filter((name) => !THROTTLER_NAMES.includes(name));
    expect(missing).toEqual([]);
  });

  test("the scan found something, so a pattern that stopped matching cannot pass this", () => {
    expect(namesUsedInSource().length).toBeGreaterThanOrEqual(4);
  });

  test("no two throttlers share a name, which would make one of them unreachable", () => {
    expect(new Set(THROTTLER_NAMES).size).toBe(ALL_THROTTLERS.length);
  });
});
