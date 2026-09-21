// Converts the brand PDF's vector artwork to SVG. `node scripts/brand/pdf-to-svg.mjs`.
//
// Written here rather than shelled out to `pdftocairo`: poppler, Inkscape and mutool are all
// absent on this machine, and adding a system dependency to a build step is worse than 120 lines
// that read the one file this project actually has.

import { readFileSync, writeFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import path from "node:path";

/**
 * What this handles, and why that is enough.
 *
 * The source is a ReportLab-produced PDF whose content stream uses a closed set of operators:
 * `m` `l` `c` `h` (paths), `f*` `S` (fill and stroke), `rg` `RG` (colour), `w` (stroke width), and
 * `BT … Tj … ET` (text). A general PDF interpreter is not needed and would be the wrong thing to
 * write; what is needed is a faithful transcription of those, with the text handled deliberately
 * rather than silently — see `extractText`.
 */

const A85 = (input) => {
  let data = input.replace(/\s/g, "");
  if (data.startsWith("<~")) data = data.slice(2);
  if (data.endsWith("~>")) data = data.slice(0, -2);

  const out = [];
  let tuple = 0;
  let count = 0;
  for (const character of data) {
    if (character === "z" && count === 0) {
      out.push(0, 0, 0, 0);
      continue;
    }
    tuple = tuple * 85 + (character.charCodeAt(0) - 33);
    count += 1;
    if (count === 5) {
      out.push((tuple >>> 24) & 255, (tuple >>> 16) & 255, (tuple >>> 8) & 255, tuple & 255);
      tuple = 0;
      count = 0;
    }
  }
  if (count > 0) {
    for (let i = count; i < 5; i += 1) tuple = tuple * 85 + 84;
    const bytes = [(tuple >>> 24) & 255, (tuple >>> 16) & 255, (tuple >>> 8) & 255, tuple & 255];
    out.push(...bytes.slice(0, count - 1));
  }
  return Buffer.from(out);
};

/** The page's content stream, decoded. Throws rather than guessing if the filters are not these. */
export function contentStream(pdfBytes) {
  const text = pdfBytes.toString("latin1");
  const objectAt = text.indexOf("/Filter [ /ASCII85Decode /FlateDecode ]");
  if (objectAt === -1) throw new Error("Unexpected filters: this converter reads ASCII85 + Flate only.");

  const streamAt = text.indexOf("stream", objectAt);
  let start = streamAt + "stream".length;
  if (text[start] === "\r") start += 1;
  if (text[start] === "\n") start += 1;
  const end = text.indexOf("endstream", start);
  return inflateSync(A85(pdfBytes.subarray(start, end).toString("latin1"))).toString("latin1");
}

const hex = (r, g, b) =>
  `#${[r, g, b].map((v) => Math.round(v * 255).toString(16).padStart(2, "0")).join("")}`.toUpperCase();

/**
 * Every colour the artwork actually uses, in the order it first appears.
 *
 * This is the point of the whole script for item 1: the tokens are **sampled from the file**
 * rather than eyeballed off a screenshot, so "deep teal" is a measurement and not a guess.
 */
export function palette(stream) {
  const seen = new Map();
  for (const match of stream.matchAll(/([\d.]+) ([\d.]+) ([\d.]+) (rg|RG)/g)) {
    const value = hex(Number(match[1]), Number(match[2]), Number(match[3]));
    if (!seen.has(value)) seen.set(value, match[4] === "rg" ? "fill" : "stroke");
  }
  return [...seen].map(([value, use]) => ({ value, use }));
}

/**
 * The text the artwork draws, with its font and size.
 *
 * **Reported rather than converted.** The wordmark is live Helvetica text, not outlined paths, so
 * a transcription into `<text font-family="Helvetica">` would render differently on every machine
 * — and this project self-hosts its fonts precisely so that cannot happen. The mark is converted;
 * the wordmark is set in the brand font by the component that uses it.
 */
export function extractText(stream) {
  const out = [];
  let font = null;
  let size = null;
  for (const match of stream.matchAll(/\/(F\d) ([\d.]+) Tf|\(([^)]*)\) Tj/g)) {
    if (match[1] !== undefined) {
      font = match[1];
      size = Number(match[2]);
    } else {
      out.push({ font, size, text: match[3] });
    }
  }
  return out;
}

/** Whether anything in the PDF is a raster image. The guard for item 2 reads this. */
export function rasterMarkers(pdfBytes) {
  const text = pdfBytes.toString("latin1");
  return ["DCTDecode", "JPXDecode", "CCITTFaxDecode", "RunLengthDecode", "/XObject"].filter((marker) =>
    text.includes(marker),
  );
}

/**
 * Transcribes the path operators to SVG.
 *
 * PDF's y axis points up and SVG's points down, so the whole drawing is flipped once with a
 * transform rather than by rewriting every coordinate — one place to be wrong instead of hundreds.
 */
export function toSvg(stream, { size = 600, title = "NOMED", only = null, monochrome = null } = {}) {
  const shapes = [];
  let fill = "#000000";
  let stroke = "#000000";
  let width = 1;
  let current = [];
  let points = [];

  const flush = (mode) => {
    if (current.length === 0) return;
    const d = current.join(" ");
    const ys = points.filter((_, index) => index % 2 === 1);
    const xs = points.filter((_, index) => index % 2 === 0);
    const box = { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };

    // `only: "mark"` keeps the symbol and drops the two gold rules and the dot that belong to the
    // wordmark line — those are typography, and the wordmark is set in the brand font, not traced.
    const keep = only === null || (only === "mark" && box.minY > 200);
    if (keep) {
      const paint = monochrome ?? (mode === "fill" ? fill : stroke);
      shapes.push({
        box,
        markup:
          mode === "fill"
            ? `<path d="${d}" fill="${paint}" fill-rule="evenodd"/>`
            : `<path d="${d}" fill="none" stroke="${paint}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round"/>`,
      });
    }
    current = [];
    points = [];
  };

  const tokens = stream.replace(/\s+/g, " ").split(" ");
  const numbers = [];
  for (const token of tokens) {
    if (/^-?[\d.]+$/.test(token)) {
      numbers.push(Number(token));
      continue;
    }
    switch (token) {
      case "rg":
        fill = hex(...numbers.slice(-3));
        break;
      case "RG":
        stroke = hex(...numbers.slice(-3));
        break;
      case "w":
        width = numbers.at(-1) ?? 1;
        break;
      case "m":
        current.push(`M ${numbers.at(-2)} ${numbers.at(-1)}`);
        points.push(...numbers.slice(-2));
        break;
      case "l":
        current.push(`L ${numbers.at(-2)} ${numbers.at(-1)}`);
        points.push(...numbers.slice(-2));
        break;
      case "c":
        current.push(`C ${numbers.slice(-6).join(" ")}`);
        points.push(...numbers.slice(-6));
        break;
      case "h":
        current.push("Z");
        break;
      case "f*":
      case "f":
        flush("fill");
        break;
      case "S":
        flush("stroke");
        break;
      default:
        break;
    }
    numbers.length = 0;
  }
  flush("fill");
  if (shapes.length === 0) throw new Error("Nothing was converted — the operator set must have changed.");

  // A tight box with a little air, so the mark fills a favicon instead of floating in a 600pt page.
  const pad = 8;
  const minX = Math.min(...shapes.map((s) => s.box.minX)) - pad;
  const maxX = Math.max(...shapes.map((s) => s.box.maxX)) + pad;
  const minY = Math.min(...shapes.map((s) => s.box.minY)) - pad;
  const maxY = Math.max(...shapes.map((s) => s.box.maxY)) + pad;
  const w = maxX - minX;
  const h = maxY - minY;

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w.toFixed(2)} ${h.toFixed(2)}" role="img" aria-label="${title}">`,
    `<title>${title}</title>`,
    // PDF's y axis points up and SVG's points down. Flipped once here rather than by rewriting
    // every coordinate: one place to be wrong instead of hundreds.
    `<g transform="translate(${(-minX).toFixed(2)} ${maxY.toFixed(2)}) scale(1 -1)">`,
    ...shapes.map((s) => s.markup),
    "</g>",
    "</svg>",
    "",
  ].join("\n");
}

if (import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, "/")}`) {
  const root = path.resolve(import.meta.dirname, "..", "..");
  const pdf = readFileSync(path.join(root, "brand-source", "NOMED_Logo_Vector.pdf"));

  console.log("raster markers:", rasterMarkers(pdf).length === 0 ? "none — it is vector" : rasterMarkers(pdf));

  const stream = contentStream(pdf);
  console.log("\npalette sampled from the artwork:");
  for (const { value, use } of palette(stream)) console.log(`  ${value}  (${use})`);

  console.log("\ntext drawn as live Helvetica, NOT as outlines:");
  for (const { font, size, text } of extractText(stream)) console.log(`  ${font} ${size}pt  "${text}"`);

  const brand = path.join(root, "apps", "web", "public", "brand");
  const written = [
    ["nomed-mark.svg", toSvg(stream, { only: "mark", title: "NOMED" })],
    // One flat colour, for a letterhead footer and any single-ink reproduction. Item 6.
    //
    // A real colour and not `currentColor`: the footer loads it through <img> so it can be cached
    // rather than bundled, and an <img> inherits nothing from the page. The navy is the monochrome
    // — one ink, and it falls to a dark grey on a greyscale printer.
    ["nomed-mark-mono.svg", toSvg(stream, { only: "mark", title: "NOMED", monochrome: "#003B46" })],
  ];
  for (const [name, svg] of written) {
    writeFileSync(path.join(brand, name), svg);
    console.log(`wrote apps/web/public/brand/${name}  (${svg.length} bytes)`);
  }
}
