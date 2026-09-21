import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * Every Tailwind colour utility in `apps/web` must name a token that `index.css` actually defines.
 *
 * ## Why this needs a test
 *
 * Tailwind resolves colours from the `@theme` block at build time. A utility naming a token that
 * does not exist is not an error — the class is simply **not generated**, so the element renders
 * with no background and no colour at all. Nothing in the toolchain objects: `tsc` never sees class
 * strings, the build succeeds, and the logical-properties guard passes because the class is
 * perfectly well-formed. It is only wrong.
 *
 * That is precisely the failure shape this project keeps hitting — a thing that appears to work.
 * `bg-accent` and `text-accent` were written across six files against a token named `primary`, and
 * survived a founder review of the schedule editor: the appointment chips in the week grid, the
 * unread dot in the notification bell and every band on the day view were invisible, and an
 * invisible tint on a white card reads as a deliberately plain design rather than as a defect.
 *
 * ## What it checks
 *
 * The colour-bearing utility prefixes, against the `--color-*` custom properties in `index.css`.
 * Tailwind's own palette (`bg-white`, `text-black`, `bg-red-500`) and non-colour values that share
 * a prefix (`text-sm`, `border-2`, `text-[11px]`) are excluded by name, so the check is about the
 * project's design tokens rather than about Tailwind's built-ins.
 */

const WEB_SRC = path.resolve(__dirname, "..", "..", "..", "web", "src");
const THEME_FILE = path.join(WEB_SRC, "index.css");

/** Prefixes whose value is a colour. `ring-` and `divide-` are here for when they are first used. */
const COLOUR_PREFIXES = ["bg", "text", "border", "ring", "fill", "stroke", "divide", "outline"];

/** Side segments that sit between a prefix and its colour: `border-t-primary`, `border-e-border`. */
const SIDE_SEGMENTS = new Set(["t", "b", "l", "r", "x", "y", "s", "e"]);

/**
 * Values that are legitimately not design tokens: Tailwind's built-in keywords, and the non-colour
 * scales that share a prefix with a colour one (`text-sm` is a size, `border-2` is a width).
 */
const NOT_A_TOKEN = new Set([
  "white", "black", "transparent", "current", "inherit", "none", "auto",
  // text-* typography scale
  "xs", "sm", "base", "lg", "xl", "2xl", "3xl", "4xl", "5xl",
  "left", "right", "center", "justify", "start", "end", "wrap", "nowrap", "balance", "pretty",
  "ellipsis", "clip", "middle", "top", "bottom", "baseline",
  // border-*/outline-* widths and styles
  "solid", "dashed", "dotted", "double", "hidden", "separate", "collapse",
  // bg-* gradient directions. Tailwind v4 spells these `bg-linear-to-*`; the v3 `bg-gradient-to-*`
  // is a deprecated alias, and this sweep caught one being written on 2026-09-15 — which is the
  // whole point of it, since an unrecognised utility generates no CSS and fails silently.
  "linear-to-t", "linear-to-b", "linear-to-l", "linear-to-r",
  "linear-to-tl", "linear-to-tr", "linear-to-bl", "linear-to-br",
  "radial", "conic",
  // bg-* positioning and sizing
  "cover", "contain", "fixed", "local", "scroll", "repeat", "gradient", "linear", "radial", "conic",
]);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return [".ts", ".tsx"].includes(path.extname(entry.name)) ? [full] : [];
  });
}

/** The tokens the stylesheet defines: `--color-primary-soft: #f0fdfa;` yields `primary-soft`. */
function definedTokens(): Set<string> {
  const css = readFileSync(THEME_FILE, "utf8");
  const names: string[] = [];
  for (const match of css.matchAll(/--color-([a-z0-9-]+)\s*:/g)) {
    const name = match[1];
    if (name !== undefined) names.push(name);
  }
  return new Set(names);
}

/**
 * Pulls the token out of a utility, or `null` if it is not a design-token colour.
 *
 * Strips Tailwind variant prefixes (`hover:`, `md:`) and an opacity suffix (`/40`), and skips
 * arbitrary values (`text-[11px]`) and numeric scales (`border-2`, `bg-red-500`).
 */
function tokenOf(rawToken: string): string | null {
  const utility = rawToken.slice(rawToken.lastIndexOf(":") + 1);
  const match = /^-?([a-z]+)-(.+)$/.exec(utility);
  if (match === null) return null;

  const prefix = match[1];
  const rest = match[2];
  if (prefix === undefined || rest === undefined) return null;
  if (!COLOUR_PREFIXES.includes(prefix)) return null;

  // `border-t-primary` and `border-e-border` colour one side. Drop the side, keep the colour;
  // a bare side (`border-b`) carries no colour at all and falls out as an empty value below.
  const head = rest.split("-")[0] ?? "";
  const sided = SIDE_SEGMENTS.has(head) ? rest.slice(head.length + 1) : rest;

  const value = sided.split("/")[0] ?? "";
  if (value === "" || value.startsWith("[")) return null;
  // A trailing number is Tailwind's own palette or a numeric scale, not one of our tokens.
  if (/(^|-)\d+$/.test(value)) return null;
  if (NOT_A_TOKEN.has(value)) return null;
  return value;
}

function unknownTokensIn(file: string, known: Set<string>): string[] {
  const relative = path.relative(WEB_SRC, file).replace(/\\/g, "/");
  return readFileSync(file, "utf8")
    .split(/\r?\n/)
    .flatMap((line, index) =>
      line
        .split(/[\s"'`{}()<>,;=]+/)
        .map(tokenOf)
        .filter((token): token is string => token !== null && !known.has(token))
        .map((token) => `${relative}:${index + 1} — "${token}" is not a --color-* token`),
    );
}

describe("apps/web colour utilities name tokens that exist", () => {
  it("reads the theme and the sources", () => {
    // Guards the guard: a wrong path either way makes the rule below pass by checking nothing.
    expect(definedTokens().size).toBeGreaterThan(10);
    expect(sourceFiles(WEB_SRC).length).toBeGreaterThan(5);
  });

  it("has no utility naming an undefined colour token", () => {
    const known = definedTokens();
    const violations = sourceFiles(WEB_SRC).flatMap((file) => unknownTokensIn(file, known));
    expect(violations).toEqual([]);
  });
});
