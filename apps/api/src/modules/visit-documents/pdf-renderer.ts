// Turns one of the documents pages into a PDF, with headless Chromium.
//
// ## Why this renders the web app's page instead of drawing the PDF itself
//
// The sheets are React components with Arabic and English text, RTL fields and a letterhead (Q9, Q29, Q45).
// A second implementation in a PDF library would have to reproduce all of it, and Arabic shaping is the part
// such libraries get wrong. Printing the page the doctor already prints means the patient's PDF is the
// doctor's paper, by construction. The cost is a browser on the server, which is what this file contains.
//
// ## Sized for a small server
//
// The production host has 1.7 GB of RAM and Chromium is hungry. So:
//   - one render at a time (a queue, not a pool), and a short queue -- a loop of requests gets a 503
//     rather than an out-of-memory kill of the whole API;
//   - the browser is launched per render and closed straight after, so its memory is returned to the
//     machine between downloads instead of being held by an idle process;
//   - results are cached by content (see `contentHash`), so the common case -- the same patient opening
//     the same link twice -- never launches a browser at all.

import { chromium } from "playwright-core";

/** How many downloads may wait behind the one being rendered. */
const MAX_WAITING = 3;
const RENDER_TIMEOUT_MS = 30_000;

export class RendererBusy extends Error {
  constructor() {
    super("The PDF renderer is busy.");
  }
}

let tail: Promise<unknown> = Promise.resolve();
let waiting = 0;

/** Runs `job` after every earlier job has finished. Refuses outright when too many are already waiting. */
function serialised<T>(job: () => Promise<T>): Promise<T> {
  if (waiting >= MAX_WAITING) return Promise.reject(new RendererBusy());
  waiting += 1;
  const run = tail.then(job, job).finally(() => {
    waiting -= 1;
  });
  tail = run.catch(() => undefined);
  return run;
}

/**
 * A page that reports itself ready: the documents page sets `window.__DOCUMENT_READY__` once the sheet is
 * laid out and its images have loaded. Waiting for network idle alone would race the first paint.
 */
export function renderPdf(url: string): Promise<Buffer> {
  return serialised(async () => {
    const browser = await chromium.launch({
      headless: true,
      // /dev/shm is 64 MB on many small hosts, which Chromium exhausts on a page of any size.
      args: ["--disable-dev-shm-usage", "--disable-gpu", "--no-first-run"],
      timeout: RENDER_TIMEOUT_MS,
    });
    try {
      const page = await browser.newPage();
      page.setDefaultTimeout(RENDER_TIMEOUT_MS);
      await page.goto(url, { waitUntil: "networkidle" });
      // A string, not a function: this file compiles for Node, which has no `window` to type-check against.
      await page.waitForFunction("window.__DOCUMENT_READY__ === true");
      const pdf = await page.pdf({ preferCSSPageSize: true, printBackground: true });
      return Buffer.from(pdf);
    } finally {
      await browser.close().catch(() => undefined);
    }
  });
}

/** A small in-memory cache: a few PDFs, for a few minutes. Not a store -- a patient opening a link twice. */
const CACHE_LIMIT = 30;
const CACHE_TTL_MS = 20 * 60_000;
const cache = new Map<string, { bytes: Buffer; at: number }>();

export function cachedPdf(key: string, now: number): Buffer | null {
  const hit = cache.get(key);
  if (hit === undefined) return null;
  if (now - hit.at > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return hit.bytes;
}

export function cachePdf(key: string, bytes: Buffer, now: number): void {
  if (cache.size >= CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { bytes, at: now });
}
