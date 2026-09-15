import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Every pair of appointment statuses must be distinguishable from every other pair, measured.
 *
 * ## Why this exists, and what the older guard could not see
 *
 * `web-colour-tokens.spec.ts` asserts that every colour utility names a token `index.css` defines.
 * That is a check of one artefact against a source of truth, and it is blind to the defect the
 * founder found by reading a screen on 1 September 2026: `BOOKED` was a pale cream chip in
 * `STATUS_TONES` and a solid orange bar in `TIMELINE_TONES`, and both files passed, because
 * `warning-soft` and `warning` are both real tokens. **A guard that checks tokens exist cannot
 * check that two files agree, and it cannot check that two colours can be told apart.**
 *
 * The same session found the second half. The three greens were placed on L* at an even 24 points
 * per step — correctly measured, recorded in three files, and still only two distinguishable
 * greens, because the first step gained 37 points of chroma and the second gained none. Measuring
 * the wrong quantity is not better than not measuring: it produces a figure nobody rechecks.
 *
 * The founder's ruling that followed: *"colour distinctness can't be eyeballed — that applies to
 * every pair, not just the ones I happened to worry about."* Amber, grey and red sat outside every
 * check, so a future change bringing amber next to a green would have passed silently.
 *
 * ## Why the primary threshold is deltaE and not deltaL*
 *
 * The founder asked for a minimum deltaL*. Recorded here because the answer is a correction rather
 * than a preference: **deltaL* alone is the exact ruler that failed.** The greens were evenly
 * spaced in L* and still collapsed. Two colours of different hue can sit 1.8 L* apart and be
 * unmistakable — `BOOKED` amber (L* 71.8) against `CONFIRMED` green-mid (L* 70.1) measures
 * deltaE 72.5 and nobody would confuse them.
 *
 * So the on-screen rule is **deltaE76 >= 25**, and L* is applied where it is genuinely the only
 * thing left: **within a single hue family**, where hue cannot help and lightness is the whole
 * signal. That is the greens, and their floor is 18.
 *
 * What is deliberately NOT asserted is a global L* floor. It cannot hold — six semantic colours
 * cannot all sit 10 L* apart while keeping the meanings red, amber and green carry — and asserting
 * it would either fail permanently or be watered down until it meant nothing. The consequence is
 * real and is stated rather than hidden: **several pairs are indistinguishable in greyscale
 * print.** `index.css` already admits this for the pale tier. Adding a claim here that the palette
 * survives a monochrome print would be exactly the kind of guarantee this project keeps getting
 * caught by.
 *
 * ## The two maps carry different signals
 *
 * A bar forty pixels wide carries no text, so its fill is the whole signal. A chip carries its own
 * label, so a pale fill with dark text reads fine — which is why the pale tier is separated by text
 * colour rather than by fill. The rule therefore differs: timeline pairs must separate on fill,
 * badge pairs must separate on **fill or text**, either one being enough.
 */

const WEB_SRC = path.resolve(__dirname, "..", "..", "..", "web", "src");
const THEME_FILE = path.join(WEB_SRC, "index.css");
const BADGE_FILE = path.join(WEB_SRC, "design-system", "display.tsx");
const TIMELINE_FILE = path.join(WEB_SRC, "features", "day-view", "DayViewPage.tsx");

/** On-screen separation. Below this two fills read as the same colour on a chip. */
const MIN_DELTA_E = 25;
/** Within one hue family, lightness is the only signal left. The greens' smallest step is 20.3. */
const MIN_DELTA_L_SAME_HUE = 18;

/**
 * Pairs that are the same colour **by design**. Listed with the reason, so that an exclusion is a
 * decision somebody made rather than a gap nobody noticed — the distinction this whole file exists
 * to make.
 */
const DELIBERATELY_ALIKE: ReadonlyArray<{ pair: [string, string]; because: string }> = [
  {
    pair: ["CANCELLED", "NO_SHOW"],
    because:
      "Both red by the 2026-08-29 ruling: colour says 'this appointment is not happening' and is " +
      "not asked to say which kind. They are separated by the strike-through on CANCELLED and by " +
      "the text label underneath it, per the note in display.tsx. Making them different reds " +
      "would claim a distinction the colour is not carrying.",
  },
];

type Lab = readonly [number, number, number];

function srgbToLab(hex: string): Lab {
  const n = parseInt(hex.slice(1), 16);
  const f = (c: number): number => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  const r = f(((n >> 16) & 255) / 255);
  const g = f(((n >> 8) & 255) / 255);
  const b = f((n & 255) / 255);
  const X = (r * 0.4124564 + g * 0.3575761 + b * 0.1804375) / 0.95047;
  const Y = r * 0.2126729 + g * 0.7151522 + b * 0.072175;
  const Z = (r * 0.0193339 + g * 0.119192 + b * 0.9503041) / 1.08883;
  const t = (v: number): number => (v > 0.008856 ? Math.cbrt(v) : 7.787 * v + 16 / 116);
  return [116 * t(Y) - 16, 500 * (t(X) - t(Y)), 200 * (t(Y) - t(Z))];
}

const deltaE = (a: Lab, b: Lab): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const deltaL = (a: Lab, b: Lab): number => Math.abs(a[0] - b[0]);

function tokens(): Map<string, string> {
  const css = readFileSync(THEME_FILE, "utf8");
  const found = new Map<string, string>();
  for (const m of css.matchAll(/--color-([a-z0-9-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)) {
    const [, name, hex] = m;
    if (name !== undefined && hex !== undefined) found.set(name, hex.toLowerCase());
  }
  return found;
}

/** Pull `STATUS: "classes",` entries out of a `Record<AppointmentStatus, string>` literal. */
function toneMap(file: string, name: string): Map<string, string> {
  const src = readFileSync(file, "utf8");
  const start = src.indexOf(`const ${name}: Record<AppointmentStatus, string> = {`);
  if (start === -1) throw new Error(`${name} not found in ${file} — the guard is checking nothing`);
  const body = src.slice(start, src.indexOf("\n};", start));
  const map = new Map<string, string>();
  for (const m of body.matchAll(/^\s*([A-Z_]+):\s*"([^"]+)"/gm)) {
    const [, status, classes] = m;
    if (status !== undefined && classes !== undefined) map.set(status, classes);
  }
  return map;
}

/**
 * The colour carrying the signal for one channel.
 *
 * Returning null means this status has nothing on this channel to compare — `bg-transparent` is one
 * such case, and it is handled by `hasNoFill` rather than by substituting the border. Standing the
 * border in for an absent fill is what produced the false collision this guard reported on its
 * first run: COMPLETED's ink-muted border against IN_CONSULTATION's active-grey, deltaE 14.6,
 * comparing an outline to a fill as though they were the same channel.
 */
function channel(classes: string, kind: "bg" | "text", palette: Map<string, string>): Lab | null {
  const pick = (prefix: string): string | null => {
    const m = new RegExp(`(?:^| )${prefix}-([a-z0-9-]+?)(?:/\\d+)?(?:$| )`).exec(` ${classes} `);
    return m === null ? null : (m[1] ?? null);
  };
  const token = pick(kind);
  if (token === null || token === "transparent") return null;
  if (token === "white") return srgbToLab("#ffffff");
  const hex = palette.get(token);
  return hex === undefined ? null : srgbToLab(hex);
}

/** A status with no fill at all. Absence is its signal — see the note on the timeline rule. */
const hasNoFill = (classes: string): boolean => / bg-transparent(?: |$)/.test(` ${classes}`);

const excluded = (a: string, b: string): boolean =>
  DELIBERATELY_ALIKE.some(({ pair }) => pair.includes(a) && pair.includes(b));

const pairsOf = (keys: string[]): Array<[string, string]> =>
  keys.flatMap((a, i) => keys.slice(i + 1).map((b): [string, string] => [a, b]));

describe("status colours are measurably distinct, pairwise", () => {
  it("reads the theme and both maps", () => {
    // Guards the guard. Every assertion below is vacuously true against an empty map, and a
    // renamed constant or a moved file is exactly how this would silently stop checking.
    expect(tokens().size).toBeGreaterThan(10);
    // 9 since Q34 added PAUSED. The number is the point: a status added without a colour would
    // otherwise render as an unstyled chip nobody notices until it is on the board.
    expect(toneMap(BADGE_FILE, "STATUS_TONES").size).toBe(9);
    expect(toneMap(TIMELINE_FILE, "TIMELINE_TONES").size).toBe(9);
  });

  it("every deliberate exclusion carries a reason", () => {
    for (const { pair, because } of DELIBERATELY_ALIKE) {
      expect(because.length).toBeGreaterThan(80);
      expect(pair).toHaveLength(2);
    }
  });

  /**
   * Exactly one status is hollow, and that is what separates it.
   *
   * COMPLETED is `bg-transparent` by the 2026-08-29 ruling — "no colour", outline only. A hollow
   * bar and a filled bar differ on a channel no hue distance can express, so comparing COMPLETED's
   * border against everyone else's fill compares two different things: it failed against
   * `active-grey` at deltaE 14.6 while being, on screen, the one bar you cannot mistake for a
   * filled one.
   *
   * The exclusion is narrow on purpose and this assertion is what keeps it narrow. If a second
   * status ever loses its fill, "absence is the signal" stops being true — two hollow bars are
   * genuinely confusable — and this fails rather than quietly widening.
   */
  it("exactly one status is hollow, so absence of fill is unambiguous", () => {
    const map = toneMap(TIMELINE_FILE, "TIMELINE_TONES");
    expect([...map.entries()].filter(([, c]) => hasNoFill(c)).map(([s]) => s)).toEqual(["COMPLETED"]);
  });

  it("timeline bars separate on fill, which is all a bar has", () => {
    const palette = tokens();
    const map = toneMap(TIMELINE_FILE, "TIMELINE_TONES");
    const violations: string[] = [];
    for (const [a, b] of pairsOf([...map.keys()])) {
      if (excluded(a, b)) continue;
      if (hasNoFill(map.get(a)!) || hasNoFill(map.get(b)!)) continue;
      const x = channel(map.get(a)!, "bg", palette);
      const y = channel(map.get(b)!, "bg", palette);
      if (x === null || y === null) continue;
      const d = deltaE(x, y);
      if (d < MIN_DELTA_E) violations.push(`${a} / ${b}: deltaE ${d.toFixed(1)} < ${MIN_DELTA_E}`);
    }
    expect(violations).toEqual([]);
  });

  it("badge chips separate on fill or on text, either being enough", () => {
    const palette = tokens();
    const map = toneMap(BADGE_FILE, "STATUS_TONES");
    const violations: string[] = [];
    for (const [a, b] of pairsOf([...map.keys()])) {
      if (excluded(a, b)) continue;
      const best = (["bg", "text"] as const).reduce((acc, kind) => {
        const x = channel(map.get(a)!, kind, palette);
        const y = channel(map.get(b)!, kind, palette);
        return x === null || y === null ? acc : Math.max(acc, deltaE(x, y));
      }, 0);
      if (best < MIN_DELTA_E) violations.push(`${a} / ${b}: best deltaE ${best.toFixed(1)} < ${MIN_DELTA_E}`);
    }
    expect(violations).toEqual([]);
  });

  it("within the green family, lightness carries what hue cannot", () => {
    const palette = tokens();
    const greens = [...palette.entries()].filter(([name]) => /^green-(soft|mid|strong|ink)$/.test(name));
    expect(greens).toHaveLength(4);
    const violations: string[] = [];
    for (const [a, b] of pairsOf(greens.map(([name]) => name))) {
      const d = deltaL(srgbToLab(palette.get(a)!), srgbToLab(palette.get(b)!));
      if (d < MIN_DELTA_L_SAME_HUE) violations.push(`${a} / ${b}: deltaL* ${d.toFixed(1)} < ${MIN_DELTA_L_SAME_HUE}`);
    }
    expect(violations).toEqual([]);
  });
});
