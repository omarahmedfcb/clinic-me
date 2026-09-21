// Proves attachments in object storage end to end: the provider writes objects, the backup reads the
// bucket, and the restore drill compares what came back. `node scripts/backup/s3-attachments-drill.mjs`.

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { S3StorageProvider } from "../../apps/api/src/modules/attachments/storage/s3.provider.ts";
import { ObjectAlreadyExists, ObjectNotFound } from "../../apps/api/src/modules/attachments/storage/storage-provider.ts";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const API = path.join(ROOT, "apps", "api");
const HERE = import.meta.dirname;
const require_ = createRequire(path.join(API, "package.json"));
const { Client } = require_("pg");

const COMPOSE = ["compose", "-f", path.join(HERE, "docker-compose.drill.yml")];
const SOURCE_DB = "clinic_os_s3_attachments_drill";
const ATTACHMENTS_BUCKET = "clinic-os-attachments";
const BACKUPS_BUCKET = "clinic-os-backups";
// Reachable from the host (published) and from a container on the compose network respectively.
const MINIO_FROM_HOST = "http://localhost:9000";
const MINIO_FROM_CONTAINER = "http://minio:9000";

const log = (message) => process.stdout.write(`s3-drill: ${message}\n`);
const failures = [];
const check = (condition, description) => {
  if (condition) log(`  ok   ${description}`);
  else {
    failures.push(description);
    log(`  FAIL ${description}`);
  }
};

const docker = (args, options = {}) =>
  execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options });

const read = (key, env) => new RegExp(`^${key}\\s*=\\s*"?([^"\\r\\n]+)"?`, "m").exec(env)?.[1];
const swap = (url, database) => url.replace(/\/[^/?]+(\?|$)/, `/${database}$1`);

const env = existsSync(path.join(API, ".env")) ? readFileSync(path.join(API, ".env"), "utf8") : "";
const superUrl = process.env["DATABASE_URL"] ?? read("DATABASE_URL", env);
const appUrl = process.env["APP_DATABASE_URL"] ?? read("APP_DATABASE_URL", env);
if (!superUrl || !appUrl) {
  console.error("DATABASE_URL and APP_DATABASE_URL must be set (apps/api/.env).");
  process.exit(1);
}

/**
 * Inside the compose network the database is the dev container, not localhost — and `?schema=` goes.
 *
 * That parameter is Prisma's, and `psql` and `pg_dump` reject it outright ("invalid URI query
 * parameter"), so a URL copied straight out of .env fails inside the backup image and nowhere else.
 */
const containerUrl = (url) =>
  url.replace(/@[^/]+\//, "@clinic-os-postgres-1:5432/").replace(/\?.*$/, "");

async function psql(url, statement) {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    return await client.query(statement);
  } finally {
    await client.end();
  }
}

function runInBackupImage(service, extraEnv, entrypoint) {
  const args = [...COMPOSE, "run", "--rm", "--no-deps"];
  for (const [key, value] of Object.entries(extraEnv)) args.push("-e", `${key}=${value}`);
  if (entrypoint) args.push("--entrypoint", entrypoint);
  args.push(service);
  return docker(args, { cwd: HERE });
}

async function main() {
  log("starting MinIO");
  docker([...COMPOSE, "up", "-d", "minio"], { cwd: HERE, stdio: "inherit" });

  // Rebuilt every run, not reused. The image carries backup.mjs and restore-drill.mjs, so a stale
  // one silently drills yesterday's code: the first run of this script did exactly that and reported
  // a 305-byte archive, which is an empty tar of a directory the old script still expected.
  log("rebuilding the backup image, so the drill exercises this branch's scripts");
  docker([...COMPOSE, "build", "backup", "drill"], { cwd: HERE, stdio: "inherit" });

  // An age identity, generated inside the image that has `age`, and kept out of the repository by
  // scripts/backup/.gitignore.
  const identityPath = path.join(HERE, "drill-identity.txt");
  if (!existsSync(identityPath)) {
    const generated = runInBackupImage("backup", {}, "age-keygen");
    writeFileSync(identityPath, generated);
  }
  const identity = readFileSync(identityPath, "utf8");
  const recipient = /public key: (age1[a-z0-9]+)/.exec(identity)?.[1];
  if (!recipient) throw new Error("no recipient in the generated age identity");

  for (const bucket of [ATTACHMENTS_BUCKET, BACKUPS_BUCKET]) {
    try {
      runInBackupImage("backup", {}, `sh -c "aws --endpoint-url ${MINIO_FROM_CONTAINER} s3 mb s3://${bucket} || true"`);
    } catch {
      /* already there */
    }
  }

  // A clean bucket every run, so "15 restored" means this run's objects and not a previous one's.
  runInBackupImage("backup", {}, `sh -c "aws --endpoint-url ${MINIO_FROM_CONTAINER} s3 rm s3://${ATTACHMENTS_BUCKET} --recursive || true"`);

  log("a migrated source database, so the drill's RLS and storage-key checks have a real schema");
  await psql(swap(superUrl, "postgres"), `DROP DATABASE IF EXISTS "${SOURCE_DB}" WITH (FORCE)`);
  await psql(swap(superUrl, "postgres"), `CREATE DATABASE "${SOURCE_DB}"`);
  execFileSync(process.execPath, [require_.resolve("prisma/build/index.js"), "migrate", "deploy"], {
    cwd: API,
    env: { ...process.env, DATABASE_URL: swap(superUrl, SOURCE_DB) },
    stdio: "inherit",
  });
  await psql(swap(superUrl, SOURCE_DB), `ALTER ROLE clinic_os_app WITH PASSWORD '${new URL(appUrl).password}'`);

  // ---- the provider, against a real object store -------------------------------------------------
  log("the provider");
  const settings = {
    endpoint: MINIO_FROM_HOST,
    bucket: ATTACHMENTS_BUCKET,
    region: "us-east-1",
    accessKeyId: "drilluser",
    secretAccessKey: "drillpassword",
  };
  const provider = new S3StorageProvider(settings);

  await provider.assertUsable();
  check(true, "assertUsable passes against a bucket that exists");

  const wrong = new S3StorageProvider({ ...settings, secretAccessKey: "not-the-password" });
  check(
    await wrong.assertUsable().then(() => false, () => true),
    "assertUsable refuses a wrong secret key (the signature is actually checked)",
  );

  const stamp = Date.now();
  const key = `${stamp}/scan.png`;
  // Random, and big enough to matter: the size floor refuses an archive under 1 KB, and both a tiny
  // object and a compressible one trip it rather than exercising the path (both happened here).
  const bytes = Buffer.concat([Buffer.from(`drill bytes ${stamp} `), randomBytes(16384)]);
  await provider.put(key, bytes);
  check(Buffer.compare(await provider.get(key), bytes) === 0, "put then get returns the same bytes");
  check(
    await provider.put(key, Buffer.from("overwrite")).then(() => false, (error) => error instanceof ObjectAlreadyExists),
    "put refuses to overwrite an existing key",
  );
  check(
    await provider.get(`${stamp}/absent.png`).then(() => false, (error) => error instanceof ObjectNotFound),
    "get throws ObjectNotFound for a key that was never written",
  );

  // A couple more objects, so the backup has something with shape to carry.
  for (const extra of ["branding/logo.png", "photos/staff.png"]) {
    await provider.put(`${stamp}/${extra}`, Buffer.concat([Buffer.from(`${extra} ${stamp} `), randomBytes(16384)]));
  }

  // ---- backup reading the bucket, and the drill comparing against it ------------------------------
  const backupEnv = {
    BACKUP_DATABASE_URL: containerUrl(swap(superUrl, SOURCE_DB)),
    BACKUP_AGE_RECIPIENT: recipient,
    BACKUP_S3_BUCKET: BACKUPS_BUCKET,
    BACKUP_S3_ENDPOINT: MINIO_FROM_CONTAINER,
    BACKUP_S3_REGION: "us-east-1",
    ATTACHMENTS_STORAGE_BACKEND: "s3",
    ATTACHMENTS_S3_ENDPOINT: MINIO_FROM_CONTAINER,
    ATTACHMENTS_S3_BUCKET: ATTACHMENTS_BUCKET,
    ATTACHMENTS_S3_REGION: "us-east-1",
  };
  const drillEnv = {
    BACKUP_S3_BUCKET: BACKUPS_BUCKET,
    BACKUP_S3_ENDPOINT: MINIO_FROM_CONTAINER,
    BACKUP_S3_REGION: "us-east-1",
    BACKUP_AGE_IDENTITY_FILE: "/identity/key.txt",
    DRILL_DATABASE_URL: containerUrl(swap(superUrl, "postgres")),
    SOURCE_DATABASE_URL: containerUrl(swap(superUrl, SOURCE_DB)),
    DRILL_APP_DATABASE_URL: containerUrl(swap(appUrl, "postgres")),
    ATTACHMENTS_STORAGE_BACKEND: "s3",
    ATTACHMENTS_S3_ENDPOINT: MINIO_FROM_CONTAINER,
    ATTACHMENTS_S3_BUCKET: ATTACHMENTS_BUCKET,
    ATTACHMENTS_S3_REGION: "us-east-1",
  };

  log("backup, reading the attachments bucket");
  const backupOutput = runInBackupImage("backup", backupEnv);
  process.stdout.write(backupOutput);
  check(/synced attachments from s3:/.test(backupOutput), "the backup synced the attachments bucket");

  log("restore drill, comparing the restore against the bucket");
  const drillOutput = runInBackupImage("drill", drillEnv);
  process.stdout.write(drillOutput);
  check(/files: [1-9]\d* restored/.test(drillOutput), "the drill restored the objects the provider wrote");
  check(/RLS: an unbound session reads zero patients/.test(drillOutput), "RLS came back with the restore");

  // ---- the failure this change exists to prevent -------------------------------------------------
  log("breaking it: a backup that reads the disk while the API writes to the bucket");
  const emptyRoot = path.join(HERE, "drill-attachments");
  mkdirSync(emptyRoot, { recursive: true });

  let brokenOutput = "";
  let refusedAtBackup = false;
  try {
    brokenOutput = runInBackupImage("backup", {
      ...backupEnv,
      ATTACHMENTS_STORAGE_BACKEND: "local",
      ATTACHMENTS_STORAGE_ROOT: "/attachments",
    });
  } catch (error) {
    refusedAtBackup = true;
    brokenOutput = `${error.stdout ?? ""}${error.stderr ?? ""}`;
  }
  process.stdout.write(brokenOutput);

  // The size floor gets there first: an archive of a directory the API never wrote to is under the
  // floor, so the bad backup is refused rather than uploaded. If a deployment ever had enough stray
  // bytes on disk to clear the floor, the drill behind it is the second net — so both are checked.
  if (refusedAtBackup) {
    check(/below the \d+-byte floor/.test(brokenOutput), "the backup REFUSES an archive that missed the bucket");
  } else {
    let drillFailed = false;
    let output = "";
    try {
      output = runInBackupImage("drill", drillEnv);
    } catch (error) {
      drillFailed = true;
      output = `${error.stdout ?? ""}${error.stderr ?? ""}`;
    }
    process.stdout.write(output);
    check(drillFailed, "the drill FAILS when the backup covered the disk and the objects live in the bucket");
  }

  log(failures.length === 0 ? "all checks passed" : `${failures.length} check(s) failed`);
  if (failures.length > 0) process.exitCode = 1;
}

await main();
