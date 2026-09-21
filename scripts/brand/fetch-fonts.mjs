// Downloads the brand webfonts and writes a self-hosted stylesheet.
// `node scripts/brand/fetch-fonts.mjs` — run once; the output is committed.
//
// Self-hosted because a runtime CDN request is a third party watching every login, a dependency on
// a network the clinic may not have, and a render-blocking round trip on a machine in Cairo.

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const FONT_DIR = path.join(ROOT, "apps", "web", "public", "fonts");
const CSS_OUT = path.join(ROOT, "apps", "web", "src", "fonts.css");

/** A modern browser's UA, or Google serves TTF instead of woff2 — four times the bytes. */
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

/**
 * **IBM Plex Sans Arabic for Arabic, Inter for Latin and numerals.**
 *
 * The founder asked for a choice between IBM Plex Sans Arabic and Almarai, with the reason stated.
 * Plex, for one functional reason and two supporting ones:
 *
 * 1. **Almarai has no 500 or 600.** It ships 300/400/700/800, and this interface leans on medium
 *    weights constantly — table headers, field labels, the active nav item, card titles. With
 *    Almarai every one of those would resolve to 400 or jump to 700, and a synthesised medium is
 *    the kind of thing that looks fine in a mockup and muddy in a dense table at 14px.
 * 2. Plex Arabic was drawn for interfaces and data density; Almarai is wider and reads as a display
 *    face, which costs horizontal room on screens this product has a lot of.
 * 3. It has a Latin companion drawn alongside it, so the two scripts sit on a compatible skeleton
 *    even though Inter is what actually sets the Latin here.
 *
 * Against it, honestly: Almarai is the rounder of the two and slightly closer to the mockup's
 * warmth. The missing weights are the concrete cost and the rounding is a preference, so the
 * concrete cost decided it. Both are OFL, so self-hosting either is fine.
 */
const FAMILIES = [
  // **Arabic only.** Inter comes first in the stack, so every Latin character and every digit is
  // already Inter's and Plex's Latin faces would never be reached — 77 KB nobody downloads.
  { family: "IBM Plex Sans Arabic", weights: [400, 500, 600, 700], slug: "plex-arabic", subsets: ["arabic"] },
  { family: "Inter", weights: [400, 500, 600, 700], slug: "inter", subsets: ["latin"] },
];

/**
 * Which subset a `unicode-range` belongs to.
 *
 * Google serves seven subsets per Inter weight — cyrillic, cyrillic-ext, greek, greek-ext,
 * vietnamese, latin-ext, latin. Taking all of them cost **1,136 KB** for a product whose interface
 * is Arabic and whose Latin is phone numbers, money and the occasional English label. Filtering to
 * what is actually rendered is the difference between a brand refresh and a regression in how long
 * the login screen takes to paint on a clinic's connection.
 */
function subsetOf(range) {
  if (range === undefined) return "latin";
  // Positive identification on the range each subset is *defined* by, and everything unmatched is
  // "other" rather than falling through to latin. The first version guessed cyrillic by `U+0400`;
  // cyrillic-ext starts at `U+0460`, matched nothing, and was written out as a second file called
  // `…-latin.woff2` that overwrote the real one. Two 25 KB downloads with the same name is the
  // shape of that bug, and it only showed up in the listing.
  if (range.includes("U+0600")) return "arabic";
  if (range.includes("U+0000-00FF")) return "latin";
  if (range.includes("U+0100-02BA")) return "latin-ext";
  return "other";
}

const cssUrl = ({ family, weights }) =>
  `https://fonts.googleapis.com/css2?family=${family.replace(/ /g, "+")}:wght@${weights.join(";")}&display=swap`;

async function main() {
  mkdirSync(FONT_DIR, { recursive: true });
  const blocks = [];
  let total = 0;

  for (const entry of FAMILIES) {
    const response = await fetch(cssUrl(entry), { headers: { "user-agent": UA } });
    if (!response.ok) throw new Error(`${entry.family}: ${response.status}`);
    const css = await response.text();

    if (!css.includes("woff2")) {
      throw new Error(`${entry.family}: got TTF, not woff2 — the user-agent was not accepted.`);
    }

    let index = 0;
    for (const face of css.split("@font-face").slice(1)) {
      const url = /url\((https:[^)]+\.woff2)\)/.exec(face)?.[1];
      const weight = /font-weight:\s*(\d+)/.exec(face)?.[1];
      const range = /unicode-range:\s*([^;]+);/.exec(face)?.[1];
      if (url === undefined || weight === undefined) continue;

      const subset = subsetOf(range);
      if (!entry.subsets.includes(subset)) continue;

      const bytes = Buffer.from(await (await fetch(url, { headers: { "user-agent": UA } })).arrayBuffer());
      const name = `${entry.slug}-${weight}-${subset}.woff2`;
      writeFileSync(path.join(FONT_DIR, name), bytes);
      total += bytes.length;
      index += 1;

      blocks.push(
        [
          "@font-face {",
          `  font-family: "${entry.family}";`,
          "  font-style: normal;",
          `  font-weight: ${weight};`,
          // `swap`, not `block`: a login screen that paints nothing for 300ms on a slow connection
          // reads as broken, and the fallback stack below is metrically close enough to not jump.
          "  font-display: swap;",
          `  src: url("/fonts/${name}") format("woff2");`,
          ...(range === undefined ? [] : [`  unicode-range: ${range};`]),
          "}",
        ].join("\n"),
      );
      console.log(`${name}  ${(bytes.length / 1024).toFixed(1)} KB`);
    }
  }

  writeFileSync(
    CSS_OUT,
    [
      "/* Generated by scripts/brand/fetch-fonts.mjs. Self-hosted: no CDN request at runtime. */",
      "",
      ...blocks,
      "",
    ].join("\n"),
  );
  console.log(`\n${blocks.length} faces, ${(total / 1024).toFixed(0)} KB total`);
  console.log(`wrote apps/web/src/fonts.css`);
}

await main();
