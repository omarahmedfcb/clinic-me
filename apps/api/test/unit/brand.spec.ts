import { readFileSync } from "node:fs";
import path from "node:path";
import { sourceFiles, stripComments } from "../../scripts/route-capabilities.ts";

/**
 * The NOMED OS rebrand's guards — items 1, 2 and 7 of the 2026-09-15 brief.
 *
 * **The rename is a display-layer change, and that distinction is what these assert.** The
 * repository, the packages, the database, the storage keys and every internal identifier stay
 * `clinic-os`; what a person reads says NOMED OS. So the sweep below looks for the old *product
 * name* in rendered strings and deliberately ignores identifiers — a guard that failed on
 * `clinic-os.locale` would either be switched off or would force a migration that orphans every
 * saved preference on every machine that already holds one.
 */

const REPO = path.resolve(__dirname, "..", "..", "..", "..");
const WEB_SRC = path.join(REPO, "apps", "web", "src");
const BRAND_DIR = path.join(REPO, "apps", "web", "public", "brand");

const webFiles = (): { name: string; source: string }[] =>
  sourceFiles(WEB_SRC, [".ts", ".tsx"])
    .filter((file) => !file.endsWith(".spec.ts") && !file.endsWith(".spec.tsx"))
    .map((file) => ({
      name: path.relative(WEB_SRC, file).split(path.sep).join("/"),
      source: readFileSync(file, "utf8"),
    }));

describe("item 2 — the logo is vector all the way down", () => {
  const svgs = ["nomed-mark.svg", "nomed-mark-mono.svg"];

  test("each converted SVG exists and is made of paths", () => {
    for (const name of svgs) {
      const svg = readFileSync(path.join(BRAND_DIR, name), "utf8");
      expect(svg).toContain("<svg");
      // Nine paths from the artwork. A count, not a "contains a path": a converter that silently
      // dropped everything but the first shape would still contain one.
      expect([...svg.matchAll(/<path /g)].length).toBeGreaterThanOrEqual(9);
    }
  });

  /**
   * **The guard the brief names: no embedded raster.**
   *
   * The easy way to "convert" a PDF is to rasterise it and wrap the PNG in an `<image>` tag. The
   * result opens in a browser, scales blurrily, and is 400 KB — and it is indistinguishable from a
   * real conversion unless somebody looks inside the file. This looks inside the file.
   */
  test("and carries no embedded raster of any kind", () => {
    for (const name of svgs) {
      const svg = readFileSync(path.join(BRAND_DIR, name), "utf8");
      for (const marker of ["<image", "xlink:href", "data:image", ";base64", "<foreignObject"]) {
        expect({ name, marker, present: svg.includes(marker) }).toEqual({ name, marker, present: false });
      }
    }
  });

  test("the mark is small enough to be chrome rather than a payload", () => {
    // 1.8 KB today. The cap is what stops somebody "fixing" the conversion by pasting a traced
    // 200 KB version in: a sidebar logo that costs more than the route it sits beside is a defect.
    const bytes = readFileSync(path.join(BRAND_DIR, "nomed-mark.svg")).length;
    expect(bytes).toBeLessThan(8 * 1024);
  });

  test("the monochrome variant really is one colour", () => {
    const svg = readFileSync(path.join(BRAND_DIR, "nomed-mark-mono.svg"), "utf8");
    const colours = new Set([...svg.matchAll(/(?:fill|stroke)="(#[0-9A-Fa-f]{6})"/g)].map((m) => m[1]));
    expect([...colours]).toEqual(["#003B46"]);
  });

  test("the login background is under the 200 KB the brief set", () => {
    const bytes = readFileSync(path.join(BRAND_DIR, "login-bg.webp")).length;
    expect(bytes).toBeLessThanOrEqual(200 * 1024);
    // And it is actually WebP, not a renamed PNG: RIFF....WEBP in the first twelve bytes.
    const header = readFileSync(path.join(BRAND_DIR, "login-bg.webp")).subarray(0, 12).toString("latin1");
    expect(header.startsWith("RIFF") && header.includes("WEBP")).toBe(true);
  });
});

describe("item 7 — the product is NOMED OS wherever a person reads it", () => {
  const files = webFiles();

  test("the sweep can see the web source, so an empty pass is impossible", () => {
    expect(files.length).toBeGreaterThan(60);
    expect(files.some((file) => file.name === "brand/brand.ts")).toBe(true);
  });

  /**
   * The old name, in anything a person reads.
   *
   * Comments are stripped first: this file's own explanation of the rule mentions the old name, and
   * so do several source comments recording why an identifier keeps it. A guard that cannot be
   * documented without failing is a guard somebody deletes.
   */
  test('no rendered string says "Clinic OS"', () => {
    const offenders: string[] = [];
    for (const { name, source } of files) {
      if (name === "brand/brand.ts") continue;
      const code = stripComments(source);
      for (const match of code.matchAll(/Clinic OS/g)) {
        const line = code.slice(0, match.index).split("\n").length;
        offenders.push(`${name}:${line}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("and neither does index.html", () => {
    const html = readFileSync(path.join(REPO, "apps", "web", "index.html"), "utf8");
    expect(html.includes("Clinic OS")).toBe(false);
    expect(html).toContain("NOMED OS");
  });

  /**
   * **The other half, and the reason this guard is two tests rather than one.**
   *
   * Identifiers keep the old name on purpose. Without this, somebody reading the test above would
   * reasonably "finish the job" by renaming `clinic-os.locale` — and every clinic's saved language
   * choice, sound preference and unsent visit draft would silently orphan on the machines that hold
   * them. The rename is a display-layer change, and this is what says so in a form that fails.
   */
  test("internal identifiers deliberately still say clinic-os", () => {
    const kept = files.filter(({ source }) => /"clinic-os\./.test(source)).map(({ name }) => name);
    expect(kept.sort()).toEqual(
      ["features/notifications/sound-preference.ts", "features/visits/draft-store.ts", "i18n/locale.ts"].sort(),
    );
  });

  test("the display name is spelled in exactly one place", () => {
    const spelled = files
      .filter(({ name, source }) => name !== "brand/brand.ts" && /"NOMED OS"/.test(stripComments(source)))
      .map(({ name }) => name);
    expect(spelled).toEqual([]);
  });
});

describe("item 1 — colour and type live in the tokens, nowhere else", () => {
  const files = webFiles();

  /**
   * A hex literal in a component is a colour that `index.css` cannot change.
   *
   * The existing `web-colour-tokens.spec.ts` checks the other direction — that every utility names
   * a token that exists — and is blind to `style={{ color: "#0f766e" }}`, which renders perfectly
   * and ignores the theme. The brief asks for this direction too.
   */
  test("no component hard-codes a colour", () => {
    const offenders: string[] = [];
    for (const { name, source } of files) {
      // The brand module holds the asset paths and the name, not colours; the token file is CSS.
      const code = stripComments(source);
      for (const match of code.matchAll(/#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b(?![0-9a-fA-F])/g)) {
        // Black and white are ink and paper, not brand colours. `print-styles.ts` forces
        // `color: #000` on a print sheet precisely so no screen token reaches a laser printer,
        // and tokenising that would make the theme able to change what ink a prescription uses.
        if (/^#(000|fff|000000|ffffff)$/i.test(match[0])) continue;
        const line = code.slice(0, match.index).split("\n").length;
        offenders.push(`${name}:${line} ${match[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("no component hard-codes a font family", () => {
    const offenders: string[] = [];
    for (const { name, source } of files) {
      const code = stripComments(source);
      if (/font-family|fontFamily/.test(code)) offenders.push(name);
    }
    expect(offenders).toEqual([]);
  });

  /** And the fonts are ours, not a CDN's — the brief's "self-host the files (no CDN at runtime)". */
  test("no stylesheet or markup fetches a font at runtime", () => {
    // Comments stripped first, and for a reason worth recording: the first version of this failed
    // on `index.html`'s own note explaining *why* the CDN links were removed. A guard that cannot
    // be documented without tripping is a guard somebody deletes rather than satisfies.
    const withoutComments = (text: string): string =>
      text.replace(/<!--[\s\S]*?-->/g, "").replace(/\/\*[\s\S]*?\*\//g, "");

    const candidates = [
      readFileSync(path.join(WEB_SRC, "index.css"), "utf8"),
      readFileSync(path.join(WEB_SRC, "fonts.css"), "utf8"),
      readFileSync(path.join(REPO, "apps", "web", "index.html"), "utf8"),
    ].map(withoutComments);
    for (const text of candidates) {
      expect(text).not.toContain("fonts.googleapis.com");
      expect(text).not.toContain("fonts.gstatic.com");
    }
    // And the faces it does declare point at files this repository ships.
    const fonts = readFileSync(path.join(WEB_SRC, "fonts.css"), "utf8");
    const urls = [...fonts.matchAll(/url\("([^"]+)"\)/g)].map((m) => m[1] as string);
    expect(urls.length).toBeGreaterThanOrEqual(8);
    for (const url of urls) {
      expect(url.startsWith("/fonts/")).toBe(true);
      expect(readFileSync(path.join(REPO, "apps", "web", "public", url.slice(1))).length).toBeGreaterThan(1000);
    }
  });
});
