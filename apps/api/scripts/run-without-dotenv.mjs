import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Runs one jest project with `.env` excluded from the environment, so that "this works without a
 * .env file" is a command anyone can run instead of a claim someone makes.
 *
 *   node scripts/run-without-dotenv.mjs unit          (npm run test:no-dotenv)
 *   node scripts/run-without-dotenv.mjs integration   (npm run test:integration:no-dotenv)
 *
 * Why this exists: four separate CI failures had the same root cause. Local runs load
 * `apps/api/.env` through `import "dotenv/config"`, and GitHub Actions has no such file -- it
 * provides a small set of variables explicitly. Anything the code reads that lives only in `.env`
 * therefore passes locally and fails on CI, and the gap is invisible until a push. The third
 * instance was JWT_SECRET, which the workflow never set. The fourth was a *unit* spec that
 * transitively imported src/prisma/client.ts and so needed APP_DATABASE_URL, which is why this
 * script now takes a project argument instead of always running the integration suite.
 *
 * What it does, in order:
 *   1. Reads the KEYS declared in `.env` (values are used only for the allowlist below).
 *   2. Deletes every one of those keys from the environment it passes on, so nothing leaks in
 *      from a parent shell that happened to export them.
 *   3. Points DOTENV_CONFIG_PATH at a file that does not exist, so `dotenv/config` in
 *      setup-env.ts and prisma.config.ts loads nothing -- including in the child process that
 *      jest's globalSetup spawns for `prisma migrate deploy`.
 *   4. Puts back ONLY the keys CI provides, taking their values from `.env` so local database
 *      credentials still work. It is the set of keys that is being tested here, not the values.
 *
 * The result: any variable the code reads that CI does not provide is missing here too, and the
 * suite fails locally in exactly the way it would fail on a runner.
 */

const here = dirname(fileURLToPath(import.meta.url));
const apiDir = resolve(here, "..");
const repoRoot = resolve(apiDir, "../..");

/**
 * The variables .github/workflows/ci.yml provides to each test step, whether at job level or step
 * level. Keep in sync with that file -- the assertion below catches the direction of drift that
 * matters (a key listed here that CI no longer sets, which would make this check pass while CI
 * fails). A key CI sets that is missing here only makes this check stricter than CI, which is safe.
 */
const PROVIDED_BY_CI = {
  // TEST_DATABASE_URL / TEST_APP_DATABASE_URL are job-level, so every step sees them; JWT_SECRET
  // and SLOT_TOKEN_SECRET are set on the integration step only.
  integration: [
    "TEST_DATABASE_URL",
    "TEST_APP_DATABASE_URL",
    "JWT_SECRET",
    "SLOT_TOKEN_SECRET",
  ],

  // The unit project gets the job-level pair and nothing else. It should not need even those: a
  // unit spec that reads a database URL has imported something it should not have. They are listed
  // because this file describes what CI provides, not what the suite ought to need.
  //
  // Added 2026-08-25, after a unit spec imported the seed's generators from a module that also
  // imports src/prisma/client.ts, which reads APP_DATABASE_URL at module scope and throws when it
  // is unset. It passed locally, where dotenv loads apps/api/.env, and failed on CI. That is the
  // fourth instance of this exact failure recorded in PHASE-1.md, and the first this script could
  // not have caught, because it only ever ran the integration project.
  unit: ["TEST_DATABASE_URL", "TEST_APP_DATABASE_URL"],
};

const project = process.argv[2] ?? "integration";
if (!Object.hasOwn(PROVIDED_BY_CI, project)) {
  console.error(`run-without-dotenv: unknown project "${project}". Use "unit" or "integration".`);
  process.exit(1);
}
const provided = PROVIDED_BY_CI[project];

function parseEnvFile(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    // No .env at all is the CI condition itself -- nothing to strip, nothing to borrow values
    // from. Callers must then supply the variables CI provides themselves, exactly as the
    // workflow does.
    return {};
  }
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match || line.trimStart().startsWith("#")) continue;
    out[match[1]] = match[2].trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

const workflow = readFileSync(resolve(repoRoot, ".github/workflows/ci.yml"), "utf8");
const notInWorkflow = provided.filter((key) => !new RegExp(`^\\s*${key}\\s*:`, "m").test(workflow));
if (notInWorkflow.length > 0) {
  console.error(
    `run-without-dotenv: ${notInWorkflow.join(", ")} is listed as provided by CI, but does not ` +
      "appear in .github/workflows/ci.yml. Either the workflow dropped it -- in which case this " +
      "check would pass while CI fails, which is the exact failure this script exists to " +
      "prevent -- or the list above is stale. Fix one of them; do not delete this assertion.",
  );
  process.exit(1);
}

const dotenvValues = parseEnvFile(resolve(apiDir, ".env"));

const childEnv = { ...process.env };
for (const key of Object.keys(dotenvValues)) delete childEnv[key];
childEnv.DOTENV_CONFIG_PATH = resolve(apiDir, "this-file-must-not-exist.env");
for (const key of provided) {
  const value = process.env[key] ?? dotenvValues[key];
  if (value !== undefined) childEnv[key] = value;
}

const missing = provided.filter((key) => childEnv[key] === undefined);
if (missing.length > 0) {
  console.error(
    `run-without-dotenv: no value available for ${missing.join(", ")}. Set them in the ` +
      "environment or in apps/api/.env -- this script strips .env from the child, but still " +
      "reads it to find local values for the variables CI supplies.",
  );
  process.exit(1);
}

console.log(`Running the ${project} suite with .env excluded (CI-equivalent environment).`);
console.log(`Variables provided: ${provided.join(", ")}`);
const stripped = Object.keys(dotenvValues).filter((key) => !provided.includes(key));
console.log(`Variables withheld: ${stripped.length > 0 ? stripped.join(", ") : "(none)"}\n`);

const args = ["jest", "--selectProjects", project];
if (project === "integration") args.push("--runInBand");
const child = spawn("npx", args, {
  cwd: apiDir,
  env: childEnv,
  stdio: "inherit",
  shell: process.platform === "win32",
});
child.on("exit", (code) => process.exit(code ?? 1));
