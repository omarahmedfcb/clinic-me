// A nightly backup: the database, then the attachments, each encrypted to an age recipient and put
// in object storage. Refuses to keep an artefact too small to be a backup, then prunes to retention.

import { spawn } from "node:child_process";
import { mkdir, rm, stat } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { artefactNames, checkSize, selectForRetention, stampFor } from "./plan.mjs";

const REQUIRED = [
  "BACKUP_DATABASE_URL",
  "BACKUP_AGE_RECIPIENT",
  "BACKUP_S3_BUCKET",
  "BACKUP_S3_ENDPOINT",
];

/**
 * Where the attachments are: a directory, or the bucket the API writes them to.
 *
 * Both produce the same artefact — a tar of the files, keyed exactly as the database references
 * them — so the restore drill checks one shape whichever backend the server runs. A backup that
 * covered the disk while the API wrote to a bucket would restore rows whose every download fails,
 * which is the failure DEPLOY.md §7 exists to prevent, one backend further along.
 */
function attachmentsSource(env = process.env) {
  const backend = (env["ATTACHMENTS_STORAGE_BACKEND"] ?? "local").trim().toLowerCase();
  if (backend === "local") {
    const root = (env["ATTACHMENTS_STORAGE_ROOT"] ?? "").trim();
    if (root === "") fail("missing environment: ATTACHMENTS_STORAGE_ROOT");
    return { kind: "local", root };
  }
  if (backend !== "s3") fail(`ATTACHMENTS_STORAGE_BACKEND must be "local" or "s3"; received "${backend}"`);

  const missing = ["ATTACHMENTS_S3_ENDPOINT", "ATTACHMENTS_S3_BUCKET"].filter(
    (name) => (env[name] ?? "").trim() === "",
  );
  if (missing.length > 0) fail(`missing environment: ${missing.join(", ")}`);
  const prefix = (env["ATTACHMENTS_S3_PREFIX"] ?? "").replace(/^\/+|\/+$/g, "");
  return {
    kind: "s3",
    endpoint: env["ATTACHMENTS_S3_ENDPOINT"],
    region: env["ATTACHMENTS_S3_REGION"] ?? env["BACKUP_S3_REGION"],
    uri: prefix.length > 0 ? `s3://${env["ATTACHMENTS_S3_BUCKET"]}/${prefix}` : `s3://${env["ATTACHMENTS_S3_BUCKET"]}`,
  };
}

const fail = (message) => {
  process.stderr.write(`backup: ${message}\n`);
  process.exit(1);
};

const log = (message) => process.stdout.write(`backup: ${message}\n`);

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], ...options });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => (stdout += chunk));
    child.stderr?.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve(stdout) : reject(new Error(`${command} exited ${code}: ${stderr.trim()}`)),
    );
  });
}

/** Every listener is attached before anything can finish: a fast `tar` closes the file first. */
const exited = (child, name) =>
  new Promise((resolve, reject) => {
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`${name} exited ${code}: ${stderr.trim()}`)),
    );
  });

/**
 * Runs `producer | age -r recipient > destination`, settling only when all three have finished.
 *
 * Both exit codes are awaited, not just age's: a `pg_dump` that dies mid-stream still yields a
 * well-formed encrypted file, which is the shape of backup that looks fine until the night it is
 * needed.
 */
async function encryptTo(producer, recipient, destination) {
  const source = spawn(producer.command, producer.args, { stdio: ["ignore", "pipe", "pipe"] });
  const age = spawn("age", ["-r", recipient], { stdio: ["pipe", "pipe", "pipe"] });
  const out = createWriteStream(destination);

  const closed = new Promise((resolve, reject) => {
    out.on("close", resolve);
    out.on("error", reject);
  });

  const finished = Promise.all([exited(source, producer.command), exited(age, "age"), closed]);

  source.stdout.pipe(age.stdin);
  age.stdout.pipe(out);

  await finished;
}

/**
 * Refuses to dump as a role that RLS filters.
 *
 * `clinic_os_app` is `NOBYPASSRLS` by design, so a dump taken as that role succeeds, exits 0, and
 * contains no rows from any tenant-scoped table. The size floor would catch an empty database; it
 * would not catch a dump that is merely missing every patient.
 */
async function assertDumpRoleSeesEverything(databaseUrl) {
  const answer = await run("psql", [
    databaseUrl,
    "-tAc",
    "select rolsuper or rolbypassrls from pg_roles where rolname = current_user",
  ]);
  if (answer.trim() !== "t") {
    fail(
      "BACKUP_DATABASE_URL connects as a role that row-level security filters. A dump taken as that " +
        "role exits 0 and contains no tenant rows. Use the migration superuser, not clinic_os_app.",
    );
  }
}

async function sizeOf(path) {
  try {
    return (await stat(path)).size;
  } catch {
    return -1;
  }
}

function s3Base() {
  const prefix = (process.env["BACKUP_S3_PREFIX"] ?? "").replace(/^\/+|\/+$/g, "");
  const bucket = process.env["BACKUP_S3_BUCKET"];
  return prefix.length > 0 ? `s3://${bucket}/${prefix}` : `s3://${bucket}`;
}

const awsArgs = (...args) => [
  "--endpoint-url",
  process.env["BACKUP_S3_ENDPOINT"],
  ...(process.env["BACKUP_S3_REGION"] ? ["--region", process.env["BACKUP_S3_REGION"]] : []),
  ...args,
];

async function upload(localPath, name) {
  await run("aws", awsArgs("s3", "cp", localPath, `${s3Base()}/${name}`));
  log(`uploaded ${name}`);
}

async function prune(referenceDate) {
  const listing = await run("aws", awsArgs("s3", "ls", `${s3Base()}/`));
  const keys = listing
    .split("\n")
    .map((line) => line.trim().split(/\s+/).pop() ?? "")
    .filter((key) => key.length > 0);

  const { keep, expire, unparsed } = selectForRetention(keys, referenceDate);
  for (const key of expire) {
    await run("aws", awsArgs("s3", "rm", `${s3Base()}/${key}`));
  }
  log(`retention: kept ${keep.length}, expired ${expire.length}, left alone ${unparsed.length}`);
}

async function main() {
  const missing = REQUIRED.filter((name) => (process.env[name] ?? "").trim().length === 0);
  if (missing.length > 0) fail(`missing environment: ${missing.join(", ")}`);

  const databaseUrl = process.env["BACKUP_DATABASE_URL"];
  const recipient = process.env["BACKUP_AGE_RECIPIENT"];
  const attachments = attachmentsSource();

  await assertDumpRoleSeesEverything(databaseUrl);

  // The instant is taken once, here, and passed everywhere: the two artefacts of one run share a
  // stamp, and retention is evaluated against the run rather than against each call to the clock.
  const startedAt = new Date();
  const names = artefactNames(stampFor(startedAt));
  const work = join(process.env["BACKUP_WORK_DIR"] ?? tmpdir(), `clinic-os-backup-${stampFor(startedAt)}`);
  await mkdir(work, { recursive: true });

  try {
    // Database first, attachments second. DEPLOY.md §7 rules this deliberately: a file uploaded
    // between the two lands in the tar and not the dump, leaving an orphan file rather than a row
    // whose download fails. Do not reorder for tidiness.
    const dumpPath = join(work, names.dump);
    await encryptTo(
      { command: "pg_dump", args: [databaseUrl, "--format=custom", "--no-owner"] },
      recipient,
      dumpPath,
    );
    const dumpSize = await sizeOf(dumpPath);
    const dumpProblem = checkSize("dump", dumpSize);
    if (dumpProblem !== null) fail(dumpProblem);
    log(`dump ${dumpSize} bytes`);

    // An S3 backend is copied down first, so the tar below is byte-identical in shape to the local
    // one: keys become paths, and the drill's per-key check needs to know nothing about backends.
    let tarRoot = attachments.root;
    if (attachments.kind === "s3") {
      tarRoot = join(work, "attachments-source");
      await mkdir(tarRoot, { recursive: true });
      await run("aws", [
        "--endpoint-url",
        attachments.endpoint,
        ...(attachments.region ? ["--region", attachments.region] : []),
        "s3",
        "sync",
        attachments.uri,
        tarRoot,
      ]);
      log(`synced attachments from ${attachments.uri}`);
    }

    const attachmentsPath = join(work, names.attachments);
    await encryptTo(
      { command: "tar", args: ["-czf", "-", "-C", tarRoot, "."] },
      recipient,
      attachmentsPath,
    );
    const attachmentsSize = await sizeOf(attachmentsPath);
    const attachmentsProblem = checkSize("attachments", attachmentsSize);
    if (attachmentsProblem !== null) fail(attachmentsProblem);
    log(`attachments ${attachmentsSize} bytes`);

    await upload(dumpPath, names.dump);
    await upload(attachmentsPath, names.attachments);
    await prune(startedAt);

    log(`ok ${stampFor(startedAt)}`);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
