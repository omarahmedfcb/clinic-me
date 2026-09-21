// Derives every raster brand asset from `brand-source/`. `node scripts/brand/build-assets.mjs`.
//
// Uses Chromium through Playwright, which is already a dependency: `sharp`, ImageMagick, `cwebp`
// and poppler are all absent here, and a canvas in a browser encodes WebP and PNG natively.

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const ROOT = path.resolve(import.meta.dirname, "..", "..");

// Playwright lives in the web workspace, not at the root — resolved from there rather than moved.
const { chromium } = createRequire(path.join(ROOT, "apps", "web", "package.json"))("@playwright/test");
const SOURCE = path.join(ROOT, "brand-source");
const OUT = path.join(ROOT, "apps", "web", "public", "brand");

/** PWA and favicon sizes. 512 and 192 are the manifest's; 180 is Apple's; 32 and 16 are the tab. */
const ICON_SIZES = [512, 192, 180, 32, 16];

/**
 * The cap the founder set for the login background, in bytes.
 *
 * Enforced here rather than trusted: the encoder is asked for a quality, and the *result* is what
 * has to be under 200 KB. The loop below walks quality down until it is, and fails loudly if even
 * the floor will not fit — a build step that silently ships a 1.4 MB hero image is the thing this
 * number exists to stop.
 */
const BACKGROUND_MAX_BYTES = 200 * 1024;

const dataUri = (file, type) => `data:${type};base64,${readFileSync(path.join(SOURCE, file)).toString("base64")}`;

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.setContent("<html><body></body></html>");

  // ---- the login background, as WebP under the cap -------------------------------------------
  const background = await page.evaluate(
    async ({ src, maxBytes, maxWidth }) => {
      const image = new Image();
      image.src = src;
      await image.decode();

      // Downscale first: 1448px wide is more than a side panel ever paints, and pixels are the
      // cheapest thing to remove before reaching for quality.
      const scale = Math.min(1, maxWidth / image.width);
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(image.width * scale);
      canvas.height = Math.round(image.height * scale);
      canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);

      for (const quality of [0.9, 0.85, 0.8, 0.75, 0.7, 0.65, 0.6, 0.55, 0.5]) {
        const uri = canvas.toDataURL("image/webp", quality);
        const bytes = Math.floor((uri.length - uri.indexOf(",") - 1) * 0.75);
        if (bytes <= maxBytes) return { uri, quality, bytes, width: canvas.width, height: canvas.height };
      }
      return null;
    },
    { src: dataUri("login_page_BG.png", "image/png"), maxBytes: BACKGROUND_MAX_BYTES, maxWidth: 1200 },
  );

  if (background === null) throw new Error("login_page_BG.png would not fit under 200 KB at any quality tried.");

  const backgroundBytes = Buffer.from(background.uri.split(",")[1], "base64");
  writeFileSync(path.join(OUT, "login-bg.webp"), backgroundBytes);
  console.log(
    `login-bg.webp  ${(backgroundBytes.length / 1024).toFixed(0)} KB  ` +
      `${background.width}x${background.height}  quality ${background.quality}  (cap 200 KB)`,
  );

  // ---- icons, from the cleaned SVG so they are the mark and not the PNG's background ----------
  const markSvg = readFileSync(path.join(OUT, "nomed-mark.svg"), "utf8");
  for (const size of ICON_SIZES) {
    const png = await page.evaluate(
      async ({ svg, size, background }) => {
        const image = new Image();
        image.src = `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(svg)))}`;
        await image.decode();

        const canvas = document.createElement("canvas");
        canvas.width = size;
        canvas.height = size;
        const context = canvas.getContext("2d");

        // A maskable-safe plate: the mark is not square, and a transparent PNG on a dark Android
        // launcher disappears. The plate is the brand's off-white, not white, so it matches the app.
        context.fillStyle = background;
        context.fillRect(0, 0, size, size);

        const pad = size * 0.12;
        const room = size - pad * 2;
        const scale = Math.min(room / image.width, room / image.height);
        const w = image.width * scale;
        const h = image.height * scale;
        context.drawImage(image, (size - w) / 2, (size - h) / 2, w, h);

        return canvas.toDataURL("image/png");
      },
      { svg: markSvg, size, background: "#F7FAF9" },
    );

    const bytes = Buffer.from(png.split(",")[1], "base64");
    writeFileSync(path.join(OUT, `icon-${size}.png`), bytes);
    console.log(`icon-${size}.png   ${(bytes.length / 1024).toFixed(1)} KB`);
  }

  // ---- the full lockup, from the PNG ----------------------------------------------------------
  //
  // **Both the SVG and this exist, deliberately.** The PDF is genuinely vector, and the mark it
  // yields is 1.8 KB and scales — right for a 28px sidebar, a favicon and a print footer. But it is
  // a flat trace of the artwork, not the artwork: in the PNG the traveller is drawn, the dune is
  // shaded and the N carries a gradient. At 28px none of that is visible; at 220px on the login
  // panel all of it is. So the lockup on the one screen that shows the logo large comes from the
  // PNG, and the chrome uses the SVG.
  const lockup = await page.evaluate(
    async ({ src, maxWidth }) => {
      const image = new Image();
      image.src = src;
      await image.decode();

      // Trim the transparent margin first — the source has a wide one, and it is what makes a
      // logo look small and badly centred when it is dropped into a panel.
      const probe = document.createElement("canvas");
      probe.width = image.width;
      probe.height = image.height;
      const probeContext = probe.getContext("2d", { willReadFrequently: true });
      probeContext.drawImage(image, 0, 0);
      const { data } = probeContext.getImageData(0, 0, probe.width, probe.height);

      let minX = probe.width;
      let minY = probe.height;
      let maxX = 0;
      let maxY = 0;
      for (let y = 0; y < probe.height; y += 1) {
        for (let x = 0; x < probe.width; x += 1) {
          if (data[(y * probe.width + x) * 4 + 3] > 8) {
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
        }
      }

      const w = maxX - minX + 1;
      const h = maxY - minY + 1;

      /*
       * Cut the two tagline lines off.
       *
       * The artwork reads "NOMED / AI CLINIC OS / Total Solutions, Total Care", and the product is
       * being renamed away from Clinic OS — so shipping the lockup whole would leave the old name
       * on the one screen everybody sees, in the one form a string sweep cannot catch.
       *
       * Found by scanning for a fully transparent row band rather than by a hard-coded fraction: a
       * fraction is a number nobody rechecks when the asset is re-exported, and this one can say
       * plainly that it failed.
       */
      const rowIsEmpty = (y) => {
        for (let x = minX; x <= maxX; x += 1) {
          if (data[(y * probe.width + x) * 4 + 3] > 8) return false;
        }
        return true;
      };

      // The artwork's horizontal bands, top to bottom: the symbol, NOMED, AI CLINIC OS, and the
      // strapline. Keep the first two and cut before the third — chosen by counting bands rather
      // than by taking "the first gap", which cut the wordmark off on the first attempt.
      const bands = [];
      let open = null;
      const gap = Math.max(4, Math.round(h * 0.012));
      for (let y = minY; y <= maxY + 1; y += 1) {
        const empty = y > maxY || rowIsEmpty(y);
        if (!empty && open === null) open = y;
        if (empty && open !== null) {
          let end = y;
          while (end <= maxY && rowIsEmpty(end)) end += 1;
          if (end - y >= gap || y > maxY) {
            bands.push({ top: open, bottom: y - 1 });
            open = null;
            y = end - 1;
          }
        }
      }

      const KEEP_BANDS = 2;
      const cut = bands.length > KEEP_BANDS ? bands[KEEP_BANDS].top : null;
      const keptHeight = (cut ?? maxY + 1) - minY;
      const scale = Math.min(1, maxWidth / w);
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(w * scale);
      canvas.height = Math.round(keptHeight * scale);
      canvas
        .getContext("2d")
        .drawImage(image, minX, minY, w, keptHeight, 0, 0, canvas.width, canvas.height);

      return {
        uri: canvas.toDataURL("image/webp", 0.92),
        width: canvas.width,
        height: canvas.height,
        trimmed: { w, h },
        taglineRemoved: cut !== null,
      };
    },
    { src: dataUri("NOMED_LOGO.png", "image/png"), maxWidth: 640 },
  );

  if (!lockup.taglineRemoved) {
    throw new Error(
      "Could not find the transparent band under the NOMED wordmark, so the 'AI CLINIC OS' tagline " +
        "would have shipped in the lockup. Re-export the logo or crop it by hand — do not relax this.",
    );
  }

  const lockupBytes = Buffer.from(lockup.uri.split(",")[1], "base64");
  writeFileSync(path.join(OUT, "nomed-lockup.webp"), lockupBytes);
  console.log(
    `nomed-lockup.webp  ${(lockupBytes.length / 1024).toFixed(0)} KB  ${lockup.width}x${lockup.height}  ` +
      `(trimmed from ${lockup.trimmed.w}x${lockup.trimmed.h})`,
  );

  // ---- a rendered preview of the mark, so the conversion can be looked at rather than trusted --
  await page.setViewportSize({ width: 760, height: 260 });
  await page.setContent(
    `<body style="margin:0;display:flex;align-items:center;gap:40px;height:260px;background:#F7FAF9;font:13px system-ui;color:#003B46;padding:0 24px">
       <figure style="margin:0;text-align:center"><div style="width:180px">${markSvg}</div><figcaption>SVG mark — 28px chrome</figcaption></figure>
       <figure style="margin:0;text-align:center"><div style="width:40px">${markSvg}</div><figcaption>at 40px</figcaption></figure>
       <figure style="margin:0;text-align:center"><img src="${lockup.uri}" style="width:240px"><figcaption>PNG lockup — login panel</figcaption></figure>
     </body>`,
  );
  await page.screenshot({ path: path.join(ROOT, "docs", "brand", "mark-preview.png") });
  console.log("docs/brand/mark-preview.png  (for eyes, not shipped)");

  await browser.close();
}

await main();
