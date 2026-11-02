// The other half of the push gate (see check-verified.mjs). `npm run verify` calls this with --clear before anything runs,
// and without it as its last step: the marker then names HEAD, and only when the tree is clean, so it cannot vouch for
// edits that were never part of the commit.
import { execFileSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";

const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const markerPath = git("rev-parse", "--git-path", "clinic-os-verified");

if (process.argv.includes("--clear")) {
  rmSync(markerPath, { force: true });
} else if (git("status", "--porcelain") === "") {
  writeFileSync(markerPath, `${git("rev-parse", "HEAD")}\n`);
} else {
  console.error("verify passed, but the working tree is not clean, so no marker was written: commit first, then run verify again.");
}
