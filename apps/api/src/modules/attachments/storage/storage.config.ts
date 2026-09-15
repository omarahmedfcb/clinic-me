/**
 * Reads the one environment variable the storage backend needs. `PHASE-4.md` Q11.
 *
 * `env` is a parameter rather than a direct read of `process.env`, so a test can exercise the
 * missing-variable and relative-path cases without mutating global state — and so this file can be
 * imported by a unit spec without dragging in anything that reads the environment at module scope.
 * That last point is a standing rule in CLAUDE.md: a unit spec that needs an environment variable
 * has an import-graph bug, and the way to not have one is to not read the environment on import.
 */

export const STORAGE_ROOT_VARIABLE = "ATTACHMENTS_STORAGE_ROOT";

/** The 10 MB cap from Q10, in bytes, spelled once and imported by both the service and the route. */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

export function storageRootFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const root = env[STORAGE_ROOT_VARIABLE];
  if (root === undefined || root.trim() === "") {
    throw new Error(
      `${STORAGE_ROOT_VARIABLE} is not set. It has no default on purpose: every candidate default ` +
        "is wrong in a way that fails silently — a path inside the repository ends up committed, " +
        "and a temp directory is emptied on reboot, taking patient scans with it. Set it to an " +
        "absolute path outside the repository and outside any directory the web server serves " +
        "(docs/DEPLOY.md).",
    );
  }
  return root.trim();
}
