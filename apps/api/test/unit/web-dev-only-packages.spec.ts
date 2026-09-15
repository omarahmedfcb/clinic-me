import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * **Packages that exist for a developer's machine must never reach a browser bundle.**
 *
 * `vite-plugin-mkcert` was added on 2026-09-02 so the app could be opened on a real iPhone: the
 * refresh cookie is `Secure`, Safari discards it over plain http on the LAN, and an HTTPS dev origin
 * is the smallest thing that unblocks it. It is a certificate helper. It has no business in code
 * that ships to a browser, and the founder made that a condition of approving it.
 *
 * Two ways that promise could quietly break, and this file closes both:
 *
 * 1. the package moves from `devDependencies` to `dependencies` — a one-word edit, usually made by
 *    an `npm install` run without `--save-dev`, and invisible in review;
 * 2. something under `apps/web/src` imports it. `src` is what Vite bundles; `vite.config.ts` is not.
 *
 * **This spec lives in `apps/api` because `apps/web` has no test runner at all** — the same reason
 * `status-colour-separation.spec.ts` and `web-locale.spec.ts` do. It reads files as text and needs
 * no database, so it runs under `npm run test:no-dotenv` like every other unit spec.
 *
 * Adding a dev-only package means adding it to `DEV_ONLY` below. A package nobody lists is a package
 * nobody guards, which is the shape `PHASE-3.md` Q25 found four times over.
 */

const WEB_ROOT = join(__dirname, "..", "..", "..", "web");
const WEB_SRC = join(WEB_ROOT, "src");

/** Dev-only by intent. Each entry is a promise this file keeps. */
const DEV_ONLY = ["vite-plugin-mkcert"] as const;

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      found.push(...sourceFiles(full));
    } else if (/\.(ts|tsx|js|jsx|css)$/.test(entry)) {
      found.push(full);
    }
  }
  return found;
}

describe("dev-only packages stay out of the web bundle", () => {
  const packageJson = JSON.parse(readFileSync(join(WEB_ROOT, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };

  test.each(DEV_ONLY)("%s is a devDependency and not a dependency", (name) => {
    expect({
      name,
      inDependencies: name in (packageJson.dependencies ?? {}),
      inDevDependencies: name in (packageJson.devDependencies ?? {}),
    }).toEqual({ name, inDependencies: false, inDevDependencies: true });
  });

  test.each(DEV_ONLY)("%s is pinned to an exact version", (name) => {
    // A range would let a caret pull in a new major on a fresh `npm install`, which for a package
    // that writes to the machine's certificate trust store is not a thing to discover by surprise.
    const version = (packageJson.devDependencies ?? {})[name];
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test("nothing under apps/web/src imports a dev-only package", () => {
    const files = sourceFiles(WEB_SRC);
    // Non-vacuity: an empty file list would make this pass while asserting nothing, which is the
    // failure this project keeps finding in its own guards.
    expect(files.length).toBeGreaterThan(10);

    const offenders = files.flatMap((file) => {
      const text = readFileSync(file, "utf8");
      return DEV_ONLY.filter((name) => text.includes(name)).map((name) => ({
        file: file.slice(WEB_ROOT.length + 1).replace(/\\/g, "/"),
        imports: name,
      }));
    });

    expect(offenders).toEqual([]);
  });
});
