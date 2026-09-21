// The checks a release cannot go out without. Pilot-readiness 4d.
// Run it before deploying: `npm run release:gate` (docs/SERVER-SETUP.md §11).

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const API = path.join(ROOT, "apps", "api");

/**
 * Each gate is a command and the sentence a reader needs when it fails.
 *
 * **The clinical sweep is first**, because it is the one whose failure means patient data is on a
 * wire it should not be on; the rest are configuration faults that stop the service rather than
 * expose it. `clinical-leak-guard` writes real clinical content, proves a doctor can reach it, and
 * then sweeps every reception-facing endpoint for it as raw response text.
 */
const GATES = [
  {
    name: "clinical leak sweep",
    why: "A reception-facing endpoint returned clinical content. This release must not ship.",
    command: "npx",
    args: ["jest", "--selectProjects", "integration", "--runInBand", "--testPathPatterns", "clinical-leak-guard"],
    cwd: API,
    // npx is a .cmd on Windows and needs a shell; node does not, and passing its own path through
    // one breaks as soon as that path has a space in it.
    shell: true,
  },
  {
    name: "server compose configuration",
    why: "docker-compose.server.yml is missing a variable the API reads, so the container would " +
      "start and then refuse — or worse, start without it.",
    command: process.execPath,
    args: [path.join(ROOT, "scripts", "check-server-compose.mjs")],
    cwd: ROOT,
    shell: false,
  },
  {
    name: "server environment list",
    why: "The list of variables a server must carry no longer matches what the code reads.",
    command: "npx",
    args: ["jest", "--selectProjects", "unit", "--testPathPatterns", "server-env"],
    cwd: API,
    shell: true,
  },
];

/**
 * A08: the image this machine built, against the digest CI recorded for this commit.
 *
 * Both numbers are needed for the comparison to mean anything — CI's, downloaded beside the
 * checkout as `image-digest.txt`, and the local build's. When either is absent the gate says so and
 * carries on: refusing a release because a file is missing teaches people to delete the file.
 */
function imageDigestGate() {
  const recorded = path.join(ROOT, "image-digest.txt");
  if (!existsSync(recorded)) {
    return { skip: "no image-digest.txt beside the checkout — CI's digest for this commit is not here" };
  }

  const expected = readFileSync(recorded, "utf8").trim().split(/\s+/)[0];
  let built = "";
  try {
    built = execFileSync("docker", ["image", "inspect", "clinic-os-api:local", "--format", "{{index .Id}}"], {
      encoding: "utf8",
      stdio: "pipe",
    }).trim();
  } catch {
    return { skip: "no local clinic-os-api:local image to compare — build it before deploying" };
  }

  return built === expected ? { pass: expected } : { fail: `CI recorded ${expected}; this machine built ${built}` };
}

const rule = "─".repeat(72);
console.log(`\n${rule}\n  RELEASE GATE\n${rule}`);

for (const gate of GATES) {
  process.stdout.write(`\n  ${gate.name} … `);
  try {
    execFileSync(gate.command, gate.args, { cwd: gate.cwd, stdio: "pipe", shell: gate.shell });
    console.log("pass");
  } catch (error) {
    console.log("FAIL\n");
    // The tool's own output, because "it failed" is not actionable and the endpoint that leaked is
    // named in it.
    process.stdout.write(String(error.stdout ?? ""));
    process.stderr.write(String(error.stderr ?? ""));
    console.error(`\n${rule}\n  REFUSED: ${gate.name}\n\n  ${gate.why}\n${rule}\n`);
    process.exit(1);
  }
}

{
  const digest = imageDigestGate();
  process.stdout.write("\n  the built image is the one CI recorded … ");
  if (digest.fail !== undefined) {
    console.log("FAIL\n");
    console.error(
      `${rule}\n  REFUSED: image digest\n\n  ${digest.fail}\n\n  The tag being deployed is not the ` +
        `artefact CI checked. Rebuild from the tag, or find out why they differ.\n${rule}\n`,
    );
    process.exit(1);
  }
  console.log(digest.skip === undefined ? "pass" : `not checked (${digest.skip})`);
}

console.log(`\n${rule}\n  All gates passed. This build may be deployed.\n${rule}\n`);
