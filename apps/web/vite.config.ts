import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import mkcert from "vite-plugin-mkcert";

/**
 * HTTPS for the dev server, so the app can be opened on a real phone.
 *
 * **The blocker is a cookie of ours, not anything about Safari.** `auth.controller.ts` sets the
 * refresh cookie `httpOnly; Secure; SameSite=Strict`, with `secure: true` hardcoded. Safari will not
 * store a `Secure` cookie delivered over plain `http://192.168.x.x`, so over the LAN a login
 * *appears* to succeed, the app runs for the fifteen minutes of the access token's life, and the
 * first page reload logs the reviewer out — presenting as "Safari doesn't keep me logged in" rather
 * than as a cookie flag. An HTTPS origin stores the cookie normally, which is why this is a
 * dev-server change and not a change to how auth cookies are issued.
 *
 * **Vite has no `--https` flag.** It was removed in Vite 5; there is no `--experimental-https`
 * either, and `vite --help` on 8.2.2 lists only `--host`. HTTPS is configured here or not at all.
 *
 * `vite-plugin-mkcert` is a **devDependency and must stay one** — a certificate helper for a
 * developer's machine has no business in a browser bundle.
 * `apps/api/test/unit/web-dev-only-packages.spec.ts` fails if it is ever imported from
 * `apps/web/src`, or if it moves out of `devDependencies`.
 *
 * **Opt-in, so `npm run dev` is unchanged.** HTTPS turns on with `--host`, which is
 * `npm run dev:https`. Making it the default would put a certificate prompt in front of every
 * ordinary dev session for the sake of a device test that happens occasionally.
 */

// Declared locally rather than pulling in @types/node: this file is the only place in apps/web
// that touches `process`, and it runs in Node by definition. Adding a dependency for one global
// would be the larger change.
declare const process: { env: Record<string, string | undefined>; argv: string[] };

// `--host` is exactly the case that needs it: binding to the LAN is when a phone can reach the
// server, and a phone cannot log in over plain http because of the Secure cookie above. Keying off
// the flag rather than an environment variable keeps this working identically in Git Bash,
// PowerShell and cmd, where `VAR=1 vite` does not.
const DEV_HTTPS = process.argv.includes("--host");

/**
 * In development the SPA is on its own port and the API on 3000, so a bare fetch("/api/...") would
 * 404 against Vite. This makes the two same-origin, which is also how they are deployed -- Caddy
 * serves the SPA and proxies /api under one hostname (docker/Caddyfile). Without it, development
 * would need CORS and cross-site cookie handling that production does not, and the refresh cookie
 * would behave differently in the two environments.
 */
/**
 * The target is overridable so a *review* stack can run beside a development one. `CLAUDE.md`
 * forbids driving a browser against the founder's dev database, which means the review API needs
 * its own port -- and on 2026-08-31 a hardcoded 3000 silently sent a review session at a
 * long-running dev API instead, because the port answered and the proxy could not be told
 * otherwise. Defaults to 3000, so nothing changes for anyone not setting it.
 */
const API_TARGET = process.env["VITE_API_TARGET"] ?? "http://localhost:3000";

const API_PROXY = {
  "/api": {
    target: API_TARGET,
    changeOrigin: true,
    rewrite: (path: string) => path.replace(/^\/api/, ""),
  },
};

// Stamped into the bundle so the login footer can say which commit is being reviewed.
// Empty defaults mean an ordinary `npm run dev` shows nothing rather than a lie.
const BUILD_STAMP = {
  "import.meta.env.VITE_BUILD_COMMIT": JSON.stringify(process.env["VITE_BUILD_COMMIT"] ?? ""),
  "import.meta.env.VITE_BUILD_TIME": JSON.stringify(process.env["VITE_BUILD_TIME"] ?? ""),
  "import.meta.env.VITE_BUILD_BRANCH": JSON.stringify(process.env["VITE_BUILD_BRANCH"] ?? ""),
};

export default defineConfig({
  define: BUILD_STAMP,
  /**
   * Source maps in the production build.
   *
   * Added 2026-09-02 after a runtime crash on the built app produced a stack with mangled names
   * only — `Cannot read properties of undefined (reading 'standing')` — and the reported field name
   * could not be told apart from a minifier artefact without going back to source by hand. That is
   * a slow way to find a one-line bug, and it was the second screen-level defect that compiled
   * cleanly.
   *
   * The trade is real and small here: source maps make the application's source readable to anyone
   * who can load the app. This SPA is served to clinic staff behind a login on a single-tenant
   * host, not to the public, and it contains no secrets — every credential lives in the API. A
   * readable stack from a real device is worth more than obscurity that was never a control.
   */
  build: { sourcemap: true },

  plugins: [
    react(),
    tailwindcss(),
    // Generates a certificate and, where it can, adds its CA to the machine's trust store. Present
    // only under the flag: the plugin turns HTTPS on by its own presence, so including it
    // unconditionally would make every dev session HTTPS.
    ...(DEV_HTTPS ? [mkcert()] : []),
  ],
  server: {
    port: 5173,
    // Not opened automatically over HTTPS: on a machine whose trust store the CA could not be
    // written to, the browser lands on a certificate warning rather than the app, which reads as a
    // broken dev server.
    open: !DEV_HTTPS,
    proxy: API_PROXY,
  },

  /**
   * `npm run preview` serves the production build with no HMR. It needs the same proxy, or a
   * reviewer looking at the built app gets a working page whose login button 404s -- which looks
   * like a broken screen rather than a missing proxy.
   */
  preview: {
    port: 4173,
    proxy: API_PROXY,
  },
});
