// Restores last night's backup into a fresh database and directory, then proves it: row counts per
// table, attachment files and their bytes, and that RLS still refuses a session with no tenant bound.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import {
  compareDigests,
  compareRowCounts,
  compareStorageKeys,
  newestCompletePair,
  storageKeyProblems,
} from "./verify.mjs";

const REQUIRED = [
  "BACKUP_S3_BUCKET",
  "BACKUP_S3_ENDPOINT",
  "BACKUP_AGE_IDENTITY_FILE",
  "DRILL_DATABASE_URL",
  "SOURCE_DATABASE_URL",
  "DRILL_APP_DATABASE_URL",
];

/**
 * The files the restore is compared against: a directory, or the bucket the API writes to.
 *
 * Mirrors `backup.mjs`. Comparing a bucket-backed deployment against a local directory would
 * compare the restore against nothing and pass, which is the shape of drill this project keeps
 * finding: green, and proving less than it claims.
 */
async function sourceAttachments(work) {
  const backend = (process.env["ATTACHMENTS_STORAGE_BACKEND"] ?? "local").trim().toLowerCase();
  if (backend === "local") {
    const root = (process.env["SOURCE_ATTACHMENTS_ROOT"] ?? "").trim();
    if (root === "") fail("missing environment: SOURCE_ATTACHMENTS_ROOT");
    return root;
  }
  if (backend !== "s3") fail(`ATTACHMENTS_STORAGE_BACKEND must be "local" or "s3"; received "${backend}"`);

  const endpoint = (process.env["ATTACHMENTS_S3_ENDPOINT"] ?? "").trim();
  const bucket = (process.env["ATTACHMENTS_S3_BUCKET"] ?? "").trim();
  if (endpoint === "" || bucket === "") {
    fail("missing environment: ATTACHMENTS_S3_ENDPOINT, ATTACHMENTS_S3_BUCKET");
  }
  const prefix = (process.env["ATTACHMENTS_S3_PREFIX"] ?? "").replace(/^\/+|\/+$/g, "");
  const region = process.env["ATTACHMENTS_S3_REGION"] ?? process.env["BACKUP_S3_REGION"];
  const mirror = join(work, "source-attachments");
  await mkdir(mirror, { recursive: true });
  await run("aws", [
    "--endpoint-url",
    endpoint,
    ...(region ? ["--region", region] : []),
    "s3",
    "sync",
    prefix.length > 0 ? `s3://${bucket}/${prefix}` : `s3://${bucket}`,
    mirror,
  ]);
  log(`source attachments mirrored from s3://${bucket}${prefix ? `/${prefix}` : ""}`);
  return mirror;
}

const log = (message) => process.stdout.write(`drill: ${message}\n`);

/**
 * Throws rather than exiting, so the `finally` that drops the scratch database always runs.
 *
 * It called `process.exit(1)` until 2026-09-16, which skips `finally` outright: a failed drill left
 * `clinic_os_restore_drill` behind on the server. The next run recreates it, so nothing broke — it
 * simply left a database nobody could account for, which on a server is its own small alarm.
 */
class DrillFailure extends Error {}

const fail = (message) => {
  throw new DrillFailure(message);
};

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

const psql = (url, sql) => run("psql", [url, "-tAc", sql]);

/** Every base table in `public` with its row count, as a plain object. */
async function rowCounts(url) {
  const listing = await psql(
    url,
    "select table_name from information_schema.tables " +
      "where table_schema = 'public' and table_type = 'BASE TABLE' order by table_name",
  );
  const tables = listing.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);

  const counts = {};
  for (const table of tables) {
    const answer = await psql(url, `select count(*) from public."${table}"`);
    counts[table] = Number(answer.trim());
  }
  return counts;
}

/**
 * Every storage key the restored database references, from every column that holds one.
 *
 * The column list is discovered rather than written down. Six columns reference the storage root
 * today — `attachments`, two on `doctors`, `tenants`, `users` and `platform_clinic_contracts` —
 * and the last of those arrived with the platform console after this drill was written. A column
 * nobody lists is a file nobody checks.
 */
async function referencedStorageKeys(url) {
  const columns = await psql(
    url,
    "select table_name || '.' || column_name from information_schema.columns " +
      "where table_schema = 'public' and column_name like '%storage_key%' order by 1",
  );
  const pairs = columns
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => line.split("."));

  if (pairs.length === 0) return [];

  const union = pairs
    .map(([table, column]) => `select "${column}" as key from public."${table}" where "${column}" is not null`)
    .join(" union all ");

  const keys = await psql(url, union);
  return keys
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** Every file under `root`, relative path to sha256. Directories are walked, not counted. */
async function digestTree(root) {
  const digests = {};
  const walk = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) {
        digests[relative(root, path).split("\\").join("/")] = createHash("sha256")
          .update(await readFile(path))
          .digest("hex");
      }
    }
  };
  await walk(root);
  return digests;
}

async function main() {
  const missing = REQUIRED.filter((name) => (process.env[name] ?? "").trim().length === 0);
  if (missing.length > 0) fail(`missing environment: ${missing.join(", ")}`);

  const identity = process.env["BACKUP_AGE_IDENTITY_FILE"];
  const clusterUrl = process.env["DRILL_DATABASE_URL"];
  const sourceUrl = process.env["SOURCE_DATABASE_URL"];
  const drillDatabase = process.env["DRILL_DATABASE_NAME"] ?? "clinic_os_restore_drill";
  const startedAt = Date.now();

  const listing = await run("aws", awsArgs("s3", "ls", `${s3Base()}/`));
  const keys = listing
    .split("\n")
    .map((line) => line.trim().split(/\s+/).pop() ?? "")
    .filter((key) => key.length > 0);

  const pair = newestCompletePair(keys);
  if (pair === null) fail("no backup in the bucket has both a dump and an attachment archive.");
  log(`restoring ${pair.stamp}`);

  const work = join(process.env["DRILL_WORK_DIR"] ?? tmpdir(), `clinic-os-drill-${pair.stamp}`);
  const restoredFiles = join(work, "attachments");
  await rm(work, { recursive: true, force: true });
  await mkdir(restoredFiles, { recursive: true });

  try {
    for (const key of [pair.dump, pair.attachments]) {
      await run("aws", awsArgs("s3", "cp", `${s3Base()}/${key}`, join(work, key)));
    }

    await run("sh", [
      "-c",
      `age -d -i "${identity}" "${join(work, pair.dump)}" > "${join(work, "restore.dump")}"`,
    ]);
    await run("sh", [
      "-c",
      `age -d -i "${identity}" "${join(work, pair.attachments)}" | tar -xzf - -C "${restoredFiles}"`,
    ]);

    // A fresh database every run. Restoring over an existing one can pass on rows that were already
    // there, which is the failure this whole script exists to make impossible.
    await psql(clusterUrl, `DROP DATABASE IF EXISTS "${drillDatabase}" WITH (FORCE)`);
    await psql(clusterUrl, `CREATE DATABASE "${drillDatabase}"`);
    const restoredUrl = clusterUrl.replace(/\/[^/?]+(\?|$)/, `/${drillDatabase}$1`);
    await run("pg_restore", [
      "--dbname",
      restoredUrl,
      "--no-owner",
      "--single-transaction",
      join(work, "restore.dump"),
    ]);

    const problems = [];

    const [sourceCounts, restoredCounts] = [await rowCounts(sourceUrl), await rowCounts(restoredUrl)];
    problems.push(...compareRowCounts(sourceCounts, restoredCounts));
    const rowTotal = Object.values(restoredCounts).reduce((sum, count) => sum + count, 0);
    log(`rows: ${Object.keys(restoredCounts).length} tables, ${rowTotal} rows`);

    const [sourceDigests, restoredDigests] = [
      await digestTree(await sourceAttachments(work)),
      await digestTree(restoredFiles),
    ];

    const referenced = await referencedStorageKeys(restoredUrl);
    const { orphans } = compareStorageKeys({ referenced, restoredFiles: Object.keys(restoredDigests) });
    problems.push(
      ...storageKeyProblems({ referenced, restoredFiles: Object.keys(restoredDigests) }),
      ...compareDigests(sourceDigests, restoredDigests),
    );
    log(
      `files: ${Object.keys(restoredDigests).length} restored, ${referenced.length} referenced by the ` +
        `database, ${orphans.length} orphaned (tolerated — §7 takes the dump first)`,
    );

    // Opened, not merely counted: a file of the right name and zero bytes restores a download that
    // still fails. The digest above already compared bytes; this proves one is readable end to end.
    const [firstFile] = Object.keys(restoredDigests);
    if (firstFile === undefined) problems.push("no attachment was restored, so none could be opened");
    else {
      const opened = await stat(join(restoredFiles, firstFile));
      if (opened.size === 0) problems.push(`${firstFile}: restored as an empty file`);
      else log(`opened ${firstFile} (${opened.size} bytes)`);
    }

    // The restore must bring the policies back with the rows. An unbound session binds no
    // app.current_tenant_id, so every policy's tenant_id = NULLIF(...) is false and rows are absent.
    const appUrl = process.env["DRILL_APP_DATABASE_URL"].replace(/\/[^/?]+(\?|$)/, `/${drillDatabase}$1`);
    try {
      const leaked = (await psql(appUrl, "select count(*) from public.patients")).trim();
      if (leaked !== "0") problems.push(`RLS: an unbound session read ${leaked} patients from the restore`);
      else log("RLS: an unbound session reads zero patients");
    } catch (error) {
      problems.push(`RLS could not be checked: ${error instanceof Error ? error.message : String(error)}`);
    }

    const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
    if (problems.length > 0) {
      for (const problem of problems) process.stderr.write(`drill: MISMATCH ${problem}\n`);
      fail(`${problems.length} mismatch(es) after ${seconds}s — this backup is not restorable as-is.`);
    }
    log(`ok ${pair.stamp} restored and verified in ${seconds}s`);
  } finally {
    await psql(clusterUrl, `DROP DATABASE IF EXISTS "${drillDatabase}" WITH (FORCE)`).catch(() => {});
    await rm(work, { recursive: true, force: true });
  }
}

// The only place the process exits non-zero. `main`'s `finally` has already dropped the scratch
// database by the time this runs, which is the whole reason `fail` throws instead of exiting.
main().catch((error) => {
  process.stderr.write(`drill: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
