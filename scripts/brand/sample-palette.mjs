// Samples the logo's actual colours, including the gradient the flat PDF does not carry.
// `node scripts/brand/sample-palette.mjs` — reporting only; it writes nothing.

import { readFileSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const { chromium } = createRequire(path.join(ROOT, "apps", "web", "package.json"))("@playwright/test");

const hex = ([r, g, b]) => `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`.toUpperCase();

/** Relative luminance, WCAG 2.1 §1.4.3. */
const luminance = ([r, g, b]) => {
  const channel = (value) => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
};

const browser = await chromium.launch();
const page = await browser.newPage();
await page.setContent("<html><body></body></html>");

const src = `data:image/png;base64,${readFileSync(path.join(ROOT, "brand-source", "NOMED_LOGO.png")).toString("base64")}`;

const found = await page.evaluate(async (source) => {
  const image = new Image();
  image.src = source;
  await image.decode();

  const canvas = document.createElement("canvas");
  canvas.width = image.width;
  canvas.height = image.height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  context.drawImage(image, 0, 0);
  const { data } = context.getImageData(0, 0, canvas.width, canvas.height);

  // Count every opaque pixel, quantised to 8 levels per channel so anti-aliasing does not swamp
  // the real fills. The interest is the teal family's two ends — the gradient the PDF flattened.
  const counts = new Map();
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 250) continue;
    const key = [data[i] >> 5, data[i + 1] >> 5, data[i + 2] >> 5].join(",");
    const entry = counts.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
    entry.n += 1;
    entry.r += data[i];
    entry.g += data[i + 1];
    entry.b += data[i + 2];
    counts.set(key, entry);
  }

  return [...counts.values()]
    .filter((entry) => entry.n > 400)
    .map((entry) => ({
      rgb: [Math.round(entry.r / entry.n), Math.round(entry.g / entry.n), Math.round(entry.b / entry.n)],
      n: entry.n,
    }))
    .sort((a, b) => b.n - a.n)
    .slice(0, 14);
}, src);

await browser.close();

console.log("The PNG's own colours, by area:\n");
for (const { rgb, n } of found) {
  const [r, g, b] = rgb;
  const teal = b > r && g > r && g > 60;
  const gold = r > 150 && g > 110 && b < 150;
  console.log(
    `  ${hex(rgb)}  L=${luminance(rgb).toFixed(3)}  ${String(n).padStart(7)} px  ` +
      `${teal ? "teal" : gold ? "gold" : ""}`,
  );
}
