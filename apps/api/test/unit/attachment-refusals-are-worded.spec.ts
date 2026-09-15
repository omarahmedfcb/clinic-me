import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * **Every refusal the attachment routes can return is worded in both locales.**
 *
 * The client renders `t("refusal." + code)`, and `translate()` returns the *key* when it has no
 * entry — so a code nobody worded reaches the doctor as the literal string `refusal.TYPE_MISMATCH`
 * in the middle of an Arabic screen. That is the same failure the founder named on 2026-09-09 when
 * patient detail showed `MALE`, arriving through a different door.
 *
 * The codes are read out of the service's own union rather than listed here, so a tenth refusal
 * added next month is covered without anyone remembering this file exists. A hand-written list is
 * wrong the first time the union changes, and wrong silently.
 */

const ROOT = path.resolve(__dirname, "..", "..");
const SERVICE = path.join(ROOT, "src", "modules", "attachments", "attachments.service.ts");
const CONTROLLER = path.join(ROOT, "src", "modules", "attachments", "attachments.controller.ts");
const STRINGS = path.resolve(ROOT, "..", "web", "src", "i18n", "strings.ts");

/** The members of `export type AttachmentRefusalReason = "A" | "B" | ...`. */
function refusalReasons(): string[] {
  const source = readFileSync(SERVICE, "utf8");
  const union = /export type AttachmentRefusalReason =([\s\S]*?);/.exec(source)?.[1];
  if (union === undefined) throw new Error("AttachmentRefusalReason is no longer a type alias here");
  return [...union.matchAll(/"([A-Z_]+)"/g)].map((match) => match[1] as string);
}

/** Codes the controller raises itself, which are not part of the service's union. */
function controllerReasons(): string[] {
  const source = readFileSync(CONTROLLER, "utf8");
  return [...source.matchAll(/refusal\("([A-Z_]+)"/g)].map((match) => match[1] as string);
}

describe("attachment refusals reach the screen as sentences", () => {
  const strings = readFileSync(STRINGS, "utf8");
  const codes = [...new Set([...refusalReasons(), ...controllerReasons()])];

  test("the union was actually found, and is not a handful", () => {
    // Without this, a regex that matched nothing would make every assertion below vacuous.
    expect(codes.length).toBeGreaterThan(5);
    expect(codes).toContain("TOO_LARGE");
  });

  test.each(codes)("refusal.%s is worded in Arabic and English", (code) => {
    // Two occurrences: the AR catalogue and the EN one. One means a locale was forgotten, which
    // shows up only for whoever switched language — the founder reviews in Arabic.
    const occurrences = strings.split(`"refusal.${code}"`).length - 1;
    expect({ code, occurrences }).toEqual({ code, occurrences: 2 });
  });
});
