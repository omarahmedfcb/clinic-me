import { readFileSync } from "node:fs";
import path from "node:path";
import {
  DEVELOPER_FACING,
  REFUSAL_CODES,
  RESOURCE_NAMES,
  type RefusalCode,
} from "../../src/common/refusals.ts";
import { sourceFiles, stripComments } from "../../scripts/route-capabilities.ts";

/**
 * Every refusal the API can return has Arabic waiting for it on the client.
 *
 * The guard the founder asked for with the ruling: *"a test that every code emitted by the API has
 * an entry in the client table, and fails when one is missing."*
 *
 * ## The failure it exists to catch
 *
 * A new refusal ships, the client has no string for it, and `t()` renders the key — so a
 * receptionist reads `refusal.ALREADY_OPEN` in the middle of an Arabic screen. That fallback is
 * deliberate and correct (a dotted key is unmistakably "nobody wrote this yet", where a blank looks
 * like the server sent nothing), but it is a *last* line, not a plan. Nothing else in the build
 * would notice, because an untranslated refusal compiles, renders, and only looks wrong to whoever
 * meets it.
 *
 * This is the same shape as `route-capability-manifest.spec.ts`, and shares its source scanner:
 * enumerate one side from the code, assert the other side covers it, fail the build on the gap.
 */

const API_ROOT = path.resolve(__dirname, "..", "..");
const REPO_ROOT = path.resolve(API_ROOT, "..", "..");
const STRINGS = path.join(REPO_ROOT, "apps", "web", "src", "i18n", "strings.ts");

/** Keys defined in the Arabic catalogue. Arabic is the catalogue; `en` is deliberately sparse. */
function arabicKeys(): Set<string> {
  const text = readFileSync(STRINGS, "utf8");
  // `const AR = {` up to `const EN`, so a key that only exists in English cannot satisfy this.
  const arabic = text.slice(text.indexOf("const AR = {"), text.indexOf("const EN"));
  return new Set([...arabic.matchAll(/^\s*"([^"]+)":/gm)].map((match) => match[1] as string));
}

const KEYS = arabicKeys();

describe("every refusal code has Arabic on the client", () => {
  test("no code in REFUSAL_CODES is missing its `refusal.*` string", () => {
    // Developer-facing codes are exempt by ruling: they render one generic apology, because
    // translating "MARK_NO_SHOW needs now, scheduledStart and noShowGraceMinutes" would dress a bug
    // up as a decision somebody at the desk could act on.
    const needed = REFUSAL_CODES.filter((code) => !DEVELOPER_FACING.includes(code));
    const missing = needed.filter((code) => !KEYS.has(`refusal.${code}`));
    expect(missing).toEqual([]);
  });

  test("the generic apology those three fall back to exists", () => {
    expect(KEYS.has("refusal.INTERNAL")).toBe(true);
  });

  test("every resource noun `NOT_FOUND` can name has Arabic, plus the unknown fallback", () => {
    // `NOT_FOUND` is one code with a `resource` param by ruling, so its sentence is only as
    // complete as this table. A missing noun renders a sentence with a hole in it, which is worse
    // than a missing sentence because it looks finished.
    const missing = RESOURCE_NAMES.filter((name) => !KEYS.has(`resource.${name}`));
    expect(missing).toEqual([]);
    expect(KEYS.has("resource.unknown")).toBe(true);
  });

  test("every code and every resource noun has a row in REFUSAL-CODES.md", () => {
    // The document calls itself the source of truth and nothing kept it true: `STALE_REVISION` and
    // `ALREADY_LINKED` both shipped without a row, so a reader would have concluded the API cannot
    // return them. Same shape as the Arabic check above, pointed at the other reader.
    //
    // A row, not a mention: the first version of this asked whether the code appeared anywhere in
    // the document, and it stayed green with the row deleted, because a *neighbouring* row named
    // the code in its prose. A guard that a deletion cannot fail is not one.
    const doc = readFileSync(path.join(REPO_ROOT, "docs", "REFUSAL-CODES.md"), "utf8");
    const rows = new Set(
      [...doc.matchAll(/^\| `([A-Z_]+)` \|/gm)].map((match) => match[1] as string),
    );
    expect(REFUSAL_CODES.filter((code) => !rows.has(code))).toEqual([]);
    expect(RESOURCE_NAMES.filter((name) => !doc.includes("`" + name + "`"))).toEqual([]);
  });

  test("no `refusal.*` string exists for a code the API cannot return", () => {
    // The other direction, and it is not pedantry: a leftover string is a code somebody removed or
    // renamed, and the rename is exactly the breaking change this contract forbids doing quietly.
    const known = new Set<string>([...REFUSAL_CODES, "INTERNAL"]);
    const orphans = [...KEYS]
      .filter((key) => key.startsWith("refusal."))
      .map((key) => key.slice("refusal.".length))
      .filter((code) => !known.has(code));
    expect(orphans).toEqual([]);
  });
});

describe("the wire carries codes, not sentences", () => {
  /**
   * **The migration is complete, and this is what keeps it complete.**
   *
   * For a few hours on 2026-09-06 this held a register of nine controllers and 46 unmigrated sites,
   * in the shape `own-capability-enforcement.ts` uses for `NO_CONSUMER`. The register is gone
   * because the debt is paid; the assertion it guarded is now simply zero.
   *
   * The rule: a controller refuses with `refusal(code, params)` and never with a string or a
   * service's English text. Nest turns a bare string into `{ message: "..." }`, which is exactly
   * the sentence the ruling removed — and it is one word away at every one of these sites.
   */
  const englishSentencesPerController = (): Record<string, number> => {
    const counts: Record<string, number> = {};
    for (const file of sourceFiles(path.join(API_ROOT, "src"), [".controller.ts"])) {
      const text = stripComments(readFileSync(file, "utf8"));
      const where = path.relative(REPO_ROOT, file).split(path.sep).join("/");
      for (const match of text.matchAll(/new \w*Exception\(\s*([^)]*)\)/g)) {
        if (/\.detail\b|\.message\b/.test(match[1] ?? "")) counts[where] = (counts[where] ?? 0) + 1;
      }
    }
    return counts;
  };

  test("no controller sends an English sentence on the wire", () => {
    expect(englishSentencesPerController()).toEqual({});
  });

  /**
   * `auth.controller.ts` is the one exception, and it is an open question rather than an oversight.
   *
   * Its five refusals -- "Not authenticated.", "Session is no longer valid. Please log in again.",
   * "That workspace is not available for this account." -- are the only English sentences left on
   * the wire. They were not in the migration register, because the register counted
   * `result.detail` and these are bare strings; and they are not obviously in scope, because the
   * 2026-09-06 ruling was about the 34 refusal codes the *services* return, and auth has no
   * service-layer refusal type at all.
   *
   * Inventing three codes for them would be guessing at a surface nobody ruled on, and the login
   * screen renders its own Arabic for 401 and 429 today rather than the server's words. Listed here
   * so the exception is visible and can only shrink.
   */
  const AWAITING_A_RULING = ["apps/api/src/modules/auth/auth.controller.ts"];

  test("and none throws a bare string either, which Nest would turn into one", () => {
    // The other way an English sentence gets onto the wire, and the easier one to write by
    // accident: `throw new NotFoundException("No such doctor.")` reads perfectly and undoes the
    // whole contract for that route. A quoted first argument is always wrong now.
    const offenders: string[] = [];
    for (const file of sourceFiles(path.join(API_ROOT, "src"), [".controller.ts"])) {
      const text = stripComments(readFileSync(file, "utf8"));
      const where = path.relative(REPO_ROOT, file).split(path.sep).join("/");
      if (AWAITING_A_RULING.includes(where)) continue;
      for (const match of text.matchAll(/new \w*Exception\(\s*(["`])/g)) {
        offenders.push(`${where}: new …Exception(${match[1] ?? ""}…`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

/** Compile-time, not runtime: a code added to the union must be added to the array too. */
const _exhaustive: readonly RefusalCode[] = REFUSAL_CODES;
void _exhaustive;
