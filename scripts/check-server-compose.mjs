// Refuses a server compose file that would start a container the API then refuses to run in.
// `node scripts/check-server-compose.mjs`. Runs in CI, and belongs in front of any deploy.

import { readFileSync } from "node:fs";
import path from "node:path";
import { REQUIRED_SERVER_ENV, S3_SERVER_ENV } from "../apps/api/src/config/server-env.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const COMPOSE = path.join(ROOT, "docker-compose.server.yml");

/**
 * The `api` service's `environment:` block, by indentation.
 *
 * Parsed here rather than through `docker compose config` on purpose: this must run on a machine
 * with no Docker and no `.env`, which is what CI is, and what a reviewer's laptop usually is.
 */
function apiEnvironment(text) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => /^ {2}api:\s*$/.test(line));
  if (start === -1) throw new Error("docker-compose.server.yml has no `api:` service");

  const service = [];
  for (const line of lines.slice(start + 1)) {
    if (/^ {2}\S/.test(line)) break;
    service.push(line);
  }

  const envStart = service.findIndex((line) => /^ {4}environment:\s*$/.test(line));
  if (envStart === -1) throw new Error("the `api` service has no `environment:` block");

  const entries = new Map();
  for (const line of service.slice(envStart + 1)) {
    if (/^ {4}\S/.test(line)) break;
    const match = /^ {6}([A-Z0-9_]+):\s*(.*)$/.exec(line);
    if (match) entries.set(match[1], match[2].trim());
  }
  return { entries, service: service.join("\n") };
}

const text = readFileSync(COMPOSE, "utf8");
const { entries, service } = apiEnvironment(text);
const problems = [];

for (const variable of REQUIRED_SERVER_ENV) {
  const value = entries.get(variable.name);
  if (value === undefined) {
    problems.push(
      `${variable.name} is not passed to the api service. Read by ${variable.readBy}` +
        `${variable.when === "deferred" ? " — and read lazily, so the container starts and fails later" : ""}.`,
    );
    continue;
  }
  // A required variable with neither `:?` (refuse) nor `:-` (a default) starts a container with an
  // empty value, which is the shape that fails at 9am rather than at deploy time.
  if (!/\$\{[A-Z0-9_]+:[?-]/.test(value)) {
    problems.push(`${variable.name} is passed as \`${value}\` — give it \`:?\` to refuse, or \`:-\` to default.`);
  }
}

for (const name of S3_SERVER_ENV) {
  if (!entries.has(name)) {
    problems.push(`${name} is not passed to the api service, so ATTACHMENTS_STORAGE_BACKEND=s3 could never work.`);
  }
}

// The local backend writes files, and a container filesystem is not where they can live.
if (!/volumes:/.test(service) || !/attachments/.test(service)) {
  problems.push("the api service mounts no attachments volume — local-backend files would die with the container.");
}

if (problems.length > 0) {
  console.error(`docker-compose.server.yml would start a container the API refuses to run in:\n`);
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error(`\n${problems.length} problem(s). apps/api/src/config/server-env.ts is the list.`);
  process.exit(1);
}

console.log(
  `docker-compose.server.yml passes all ${REQUIRED_SERVER_ENV.length} required variables ` +
    `(+${S3_SERVER_ENV.length} S3 settings) to the api service, and mounts the attachments volume.`,
);
