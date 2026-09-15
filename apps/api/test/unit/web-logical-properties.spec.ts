import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * `apps/web` must express direction with CSS logical properties, never physical left/right
 * (ARCHITECTURE.md §2: "RTL via CSS logical properties, not a mirrored stylesheet").
 *
 * This is worth a test rather than a convention because the failure is invisible. While the
 * document direction is frozen to `rtl`, a hardcoded physical side is often *accidentally correct*
 * -- inline-end and `left` are the same place -- so nothing looks wrong until direction becomes
 * dynamic, at which point the bug appears in the language nobody was testing. That is exactly how
 * the `Select` chevron in `design-system/fields.tsx` stayed wrong: its own comment claimed the side
 * was resolved from the document direction, and it was not.
 *
 * The natural home for this is an ESLint rule. ESLint cannot run on this project at all --
 * typescript-eslint refuses to load against TypeScript 7, and the recorded decision in PHASE-1.md
 * is to wait for upstream rather than work around it. This gives the same protection with no new
 * dependency and no reopening of that decision.
 *
 * It lives in the API's Jest suite because that is the only test runner in the repo; a web-side
 * runner would be a new dependency. Cross-tree, but both trees are always present together.
 */

const WEB_SRC = path.resolve(__dirname, "..", "..", "..", "web", "src");
const SCANNED_EXTENSIONS = [".ts", ".tsx", ".css"];

/** A line carrying this marker is skipped, for the rare case where a physical side is genuinely right. */
const ESCAPE_HATCH = "rtl-allow-physical";

/**
 * Tailwind utilities that resolve to a physical side. The value guard on `left-`/`right-` is what
 * keeps prose like "right-to-left" in a comment from tripping the rule: a real utility is followed
 * by a number, a bracket, or one of Tailwind's keyword values.
 */
const CLASS_RULES: ReadonlyArray<{ pattern: RegExp; use: string }> = [
  { pattern: /^-?m[lr]-/, use: "ms-* / me-*" },
  { pattern: /^p[lr]-/, use: "ps-* / pe-*" },
  { pattern: /^-?(left|right)-(\d|\[|\.|full$|auto$|px$)/, use: "start-* / end-*" },
  { pattern: /^text-(left|right)$/, use: "text-start / text-end" },
  { pattern: /^border-[lr]($|-)/, use: "border-s-* / border-e-*" },
  { pattern: /^rounded-([lr]|[tb][lr])($|-)/, use: "rounded-s-* / rounded-e-*" },
  { pattern: /^float-(left|right)$/, use: "float-start / float-end" },
  /**
   * The opposite mistake, and a worse one. `inset-inline-start-0` *looks* more logical than
   * `start-0` and reads as if it were the more correct spelling -- but Tailwind has no such
   * utility, so it compiles to nothing at all and the element silently keeps `position: fixed`
   * with every offset left at `auto`.
   *
   * That is what put the appointment detail drawer off-screen: it was in the DOM, fully populated,
   * with no CSS placing it, so clicking a patient produced a dimmed page and no panel. A physical
   * side is at least *visible* when wrong; this failure renders nothing and looks like a blank
   * screen or a data-loading bug, which is where the debugging time went.
   *
   * The advice this very file used to give ("use inset-inline-start / inset-inline-end") is how
   * the wrong spelling got written in the first place -- correct as a CSS property name, wrong as
   * a class -- so the LINE_RULES wording below now says which of the two it means.
   */
  {
    // Value guard, same reason as the left-/right- rule above: prose naming the wrong spelling
    // ("not `inset-inline-start-*`") must not trip the rule that exists to describe it.
    pattern: /^inset-(inline|block)(-(start|end))?-(\d|\[|\.|full$|auto$|px$)/,
    use: "start-* / end-* / inset-x-* / inset-y-* / top-* / bottom-* — Tailwind has no inset-inline-*/inset-block-* utility, so that spelling generates no CSS",
  },
];

/** Physical CSS declarations, and the JSX style-object spellings of the same thing. */
const LINE_RULES: ReadonlyArray<{ pattern: RegExp; use: string }> = [
  { pattern: /(^|[\s;{])(margin|padding|border)-(left|right)\s*:/, use: "the -inline-start / -inline-end form" },
  { pattern: /(^|[\s;{])(left|right)\s*:/, use: "the inset-inline-start / inset-inline-end CSS properties in a stylesheet, or the start-* / end-* utilities in a className" },
  { pattern: /\b(margin|padding|border)(Left|Right)\b/, use: "the InlineStart / InlineEnd form" },
  { pattern: /text-align\s*:\s*(left|right)\b/, use: "text-align: start / end" },
  // `background-position` has no logical keyword at all, so any left/right in one is unfixable in
  // place. Draw the thing as a positioned element with `inset-inline-*` instead.
  { pattern: /background-?[Pp]osition\s*:[^;]*\b(left|right)\b/, use: "a positioned element with inset-inline-*" },
];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return sourceFiles(full);
    }
    return SCANNED_EXTENSIONS.includes(path.extname(entry.name)) ? [full] : [];
  });
}

/** Strips Tailwind variant prefixes (`md:`, `hover:`) so `md:ml-4` is checked as `ml-4`. */
function bareUtility(token: string): string {
  return token.slice(token.lastIndexOf(":") + 1);
}

function violationsIn(file: string): string[] {
  const isStylesheet = path.extname(file) === ".css";
  const relative = path.relative(WEB_SRC, file).replace(/\\/g, "/");

  return readFileSync(file, "utf8")
    .split(/\r?\n/)
    .flatMap((line, index) => {
      if (line.includes(ESCAPE_HATCH)) {
        return [];
      }
      const where = `${relative}:${index + 1}`;
      const found: string[] = [];

      for (const rule of LINE_RULES) {
        if (rule.pattern.test(line)) {
          found.push(`${where} — physical CSS side; use ${rule.use}`);
        }
      }

      if (!isStylesheet) {
        for (const token of line.split(/[\s"'`{}()<>,;=]+/)) {
          const utility = bareUtility(token);
          for (const rule of CLASS_RULES) {
            if (rule.pattern.test(utility)) {
              found.push(`${where} — "${utility}"; use ${rule.use}`);
            }
          }
        }
      }

      return found;
    });
}

describe("apps/web uses CSS logical properties, not physical sides", () => {
  it("finds source files to scan", () => {
    // Guards the guard: a wrong path would make the rule below pass by scanning nothing.
    expect(sourceFiles(WEB_SRC).length).toBeGreaterThan(5);
  });

  it("has no physical left/right styling", () => {
    const violations = sourceFiles(WEB_SRC).flatMap(violationsIn);
    expect(violations).toEqual([]);
  });
});
