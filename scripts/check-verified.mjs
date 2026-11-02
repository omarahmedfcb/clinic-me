// Called by .githooks/pre-push for each pushed commit: refused unless `npm run verify` last passed on exactly that commit.
// Ruled 2026-11-01, after a `;` in a compound command pushed over a red gate. The escape is --no-verify, reason in the commit.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

/** The refusal to print, or null when the marker names exactly this commit. */
export function verifiedRefusal(marker, sha) {
  if (marker === null) return `push refused: npm run verify has not passed on ${sha} (no marker; the last run failed, or never ran on a clean tree).`;
  if (marker.trim() !== sha) return `push refused: npm run verify last passed on ${marker.trim()}, not on ${sha}. Run it on this commit.`;
  return null;
}

if (process.argv[1]?.endsWith("check-verified.mjs")) {
  const sha = process.argv[2] ?? "";
  const path = execFileSync("git", ["rev-parse", "--git-path", "clinic-os-verified"], { encoding: "utf8" }).trim();
  const refused = verifiedRefusal(existsSync(path) ? readFileSync(path, "utf8") : null, sha);
  if (refused !== null) {
    console.error(refused);
    process.exit(1);
  }
}
