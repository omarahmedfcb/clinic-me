import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * **Every text/background pair the interface actually renders clears WCAG AA.**
 *
 * The founder's brief for the NOMED OS palette: *"Contrast: AA at minimum on every text/background
 * pair — assert it in a test."* This is that test, and it reads `index.css` rather than a copy, so
 * a token edited to look better on a designer's monitor fails here rather than in a clinic.
 *
 * ## Why the pairs are listed rather than derived
 *
 * A sweep over every possible combination of tokens would be 400 pairs, most of which never meet —
 * nobody puts `danger` text on a `primary` fill — and it would either fail permanently or be
 * watered down with exceptions until it meant nothing. The list below is what the components
 * actually pair, so a failure is always a real screen.
 *
 * ## The two thresholds, and why both exist
 *
 * WCAG 2.1 §1.4.3 asks **4.5:1** of body text and **3:1** of text at 18.66px bold or 24px regular.
 * §1.4.11 asks **3:1** of a graphical object that carries meaning without text — the timeline's
 * status bars are that, and they are why `--color-active-grey` has the value it has.
 *
 * Nothing here is asserted at AAA. Seven of these pairs would fail it, and claiming a standard the
 * palette does not meet is the failure mode this project keeps writing guards against.
 */

const THEME = path.resolve(__dirname, "..", "..", "..", "web", "src", "index.css");

/** `--color-x: #rrggbb;` from the theme block. The file is the source of truth, not a copy here. */
function tokens(): Map<string, string> {
  const css = readFileSync(THEME, "utf8");
  const found = new Map<string, string>();
  for (const match of css.matchAll(/--color-([a-z-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)) {
    found.set(match[1] as string, (match[2] as string).toLowerCase());
  }
  return found;
}

/** WCAG 2.1 relative luminance. */
export function luminance(hex: string): number {
  const value = Number.parseInt(hex.slice(1), 16);
  const channels = [(value >> 16) & 255, (value >> 8) & 255, value & 255].map((raw) => {
    const c = raw / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * (channels[0] ?? 0) + 0.7152 * (channels[1] ?? 0) + 0.0722 * (channels[2] ?? 0);
}

export function contrast(a: string, b: string): number {
  const first = luminance(a);
  const second = luminance(b);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

const AA_TEXT = 4.5;
const AA_LARGE = 3;

/** foreground, background, minimum. `white` is spelled out because it is not a token. */
const PAIRS: { fg: string; bg: string; min: number; what: string }[] = [
  // ---- body text on the two page surfaces --------------------------------------------------
  { fg: "ink", bg: "surface", min: AA_TEXT, what: "body text on a card" },
  { fg: "ink", bg: "surface-sunken", min: AA_TEXT, what: "body text on the page" },
  { fg: "ink-muted", bg: "surface", min: AA_TEXT, what: "secondary text on a card" },
  { fg: "ink-muted", bg: "surface-sunken", min: AA_TEXT, what: "secondary text on the page" },
  { fg: "ink-subtle", bg: "surface", min: AA_TEXT, what: "hints and captions on a card" },
  { fg: "ink-subtle", bg: "surface-sunken", min: AA_TEXT, what: "hints and captions on the page" },

  // ---- semantic text ------------------------------------------------------------------------
  { fg: "primary", bg: "surface", min: AA_TEXT, what: "a link" },
  { fg: "primary", bg: "surface-sunken", min: AA_TEXT, what: "a link on the page" },
  { fg: "primary", bg: "primary-soft", min: AA_TEXT, what: "a badge's own text" },
  { fg: "danger", bg: "surface", min: AA_TEXT, what: "a refusal" },
  { fg: "danger", bg: "surface-sunken", min: AA_TEXT, what: "a refusal on the page" },
  { fg: "danger", bg: "danger-soft", min: AA_TEXT, what: "a refusal banner" },
  { fg: "warning", bg: "surface", min: AA_TEXT, what: "a warning" },
  { fg: "warning", bg: "warning-soft", min: AA_TEXT, what: "a warning banner" },
  { fg: "success", bg: "surface", min: AA_TEXT, what: "a confirmation" },
  { fg: "success", bg: "success-soft", min: AA_TEXT, what: "a confirmation banner" },
  { fg: "info", bg: "surface", min: AA_TEXT, what: "an informational note" },
  { fg: "info", bg: "info-soft", min: AA_TEXT, what: "an informational banner" },

  // ---- white on a filled control -------------------------------------------------------------
  { fg: "white", bg: "primary", min: AA_TEXT, what: "the primary button, and the active nav item" },
  { fg: "white", bg: "primary-hover", min: AA_TEXT, what: "the primary button, hovered" },
  { fg: "white", bg: "danger", min: AA_TEXT, what: "a destructive button" },
  { fg: "white", bg: "danger-hover", min: AA_TEXT, what: "a destructive button, hovered" },
  { fg: "white", bg: "ink", min: AA_TEXT, what: "the sidebar's own text" },

  // ---- the brand gold, which cannot carry white ----------------------------------------------
  { fg: "secondary-ink", bg: "secondary", min: AA_TEXT, what: "text on a gold fill" },
  { fg: "ink", bg: "secondary-soft", min: AA_TEXT, what: "text on a gold tint" },

  // ---- graphical objects, §1.4.11 -------------------------------------------------------------
  { fg: "primary-light", bg: "surface", min: AA_LARGE, what: "a chart accent against a card" },
  { fg: "active-grey", bg: "info-soft", min: AA_LARGE, what: "an in-consultation bar on a free slot" },
  { fg: "border-strong", bg: "surface", min: 1.2, what: "a visible rule on a card" },
];

describe("the palette clears WCAG AA where it is read", () => {
  const theme = tokens();
  const resolve = (name: string): string => {
    if (name === "white") return "#ffffff";
    const value = theme.get(name);
    if (value === undefined) throw new Error(`index.css defines no --color-${name}`);
    return value;
  };

  test("index.css is being read, so an empty pass is impossible", () => {
    // Without this, a rename of the theme file or of the custom-property prefix makes every
    // assertion below vacuously true — the failure this project has found in its own tooling
    // repeatedly, most recently in a route sweep that listed one route and claimed to list all.
    expect(theme.size).toBeGreaterThan(20);
    expect(theme.get("primary")).toBe("#0b7a80");
    expect(theme.get("ink")).toBe("#003b46");
  });

  test("every listed pair meets its threshold", () => {
    const failures = PAIRS.filter(({ fg, bg, min }) => contrast(resolve(fg), resolve(bg)) < min).map(
      ({ fg, bg, min, what }) =>
        `${fg} on ${bg} (${what}): ${contrast(resolve(fg), resolve(bg)).toFixed(2)} < ${min}`,
    );
    expect(failures).toEqual([]);
  });

  /**
   * The brand gold is a fill, not a text colour, and this is the assertion that keeps it one.
   *
   * `--color-warning` is a dark gold rather than `--color-secondary` precisely because the brand
   * gold measures 2.25:1 on white. Somebody reading the brief — "warning = secondary" — would
   * reasonably set them equal; this fails when they do.
   */
  test("the brand gold is never used as text on a light surface", () => {
    expect(contrast(resolve("secondary"), resolve("surface"))).toBeLessThan(AA_TEXT);
    expect(contrast(resolve("warning"), resolve("surface"))).toBeGreaterThanOrEqual(AA_TEXT);
    expect(resolve("warning")).not.toBe(resolve("secondary"));
  });

  /** The same, for the accent teal: an accent, never a text background. */
  test("primary-light is an accent and cannot carry white text", () => {
    expect(contrast("#ffffff", resolve("primary-light"))).toBeLessThan(AA_TEXT);
    expect(contrast(resolve("info"), resolve("surface"))).toBeGreaterThanOrEqual(AA_TEXT);
  });

  test("the ratios are computed, not asserted from memory", () => {
    // Two published values, so a mistake in the formula itself cannot pass: black on white is
    // exactly 21, and WCAG's own worked example of #777 on white is 4.48.
    expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrast("#777777", "#ffffff")).toBeCloseTo(4.48, 2);
  });
});
