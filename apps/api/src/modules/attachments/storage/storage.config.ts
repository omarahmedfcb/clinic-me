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

export const STORAGE_BACKEND_VARIABLE = "ATTACHMENTS_STORAGE_BACKEND";

export type AttachmentsBackend =
  | { kind: "local"; root: string }
  | {
      kind: "s3";
      endpoint: string;
      bucket: string;
      region: string;
      accessKeyId: string;
      secretAccessKey: string;
      prefix?: string;
    };

/**
 * Which backend, and its settings. `local` unless `ATTACHMENTS_STORAGE_BACKEND` says `s3`.
 *
 * Defaulting to the filesystem keeps every existing deployment, the test suite and the review build
 * working with no new variable. What is deliberately *not* defaulted is anything inside the `s3`
 * branch: a missing bucket or endpoint refuses to start rather than falling back to a local
 * directory, because a silent fallback would store a patient's scan on a server's disk when the
 * operator believed it was in object storage — and nothing would say so until a restore.
 */
export function attachmentsBackendFromEnv(env: NodeJS.ProcessEnv = process.env): AttachmentsBackend {
  const backend = (env[STORAGE_BACKEND_VARIABLE] ?? "local").trim().toLowerCase();
  if (backend === "local") return { kind: "local", root: storageRootFromEnv(env) };
  if (backend !== "s3") {
    throw new Error(
      `${STORAGE_BACKEND_VARIABLE} must be "local" or "s3"; received "${env[STORAGE_BACKEND_VARIABLE]}".`,
    );
  }

  const required = {
    endpoint: "ATTACHMENTS_S3_ENDPOINT",
    bucket: "ATTACHMENTS_S3_BUCKET",
    region: "ATTACHMENTS_S3_REGION",
    accessKeyId: "ATTACHMENTS_S3_ACCESS_KEY_ID",
    secretAccessKey: "ATTACHMENTS_S3_SECRET_ACCESS_KEY",
  } as const;

  const missing = Object.values(required).filter((name) => (env[name] ?? "").trim() === "");
  if (missing.length > 0) {
    throw new Error(
      `${STORAGE_BACKEND_VARIABLE}=s3 needs ${missing.join(", ")}. None of them has a default: ` +
        "an object store this service cannot reach is a service that cannot store a patient's scan, " +
        "and it should refuse to start rather than discover that on the first upload.",
    );
  }

  const prefix = (env["ATTACHMENTS_S3_PREFIX"] ?? "").trim();
  return {
    kind: "s3",
    endpoint: (env[required.endpoint] ?? "").trim(),
    bucket: (env[required.bucket] ?? "").trim(),
    region: (env[required.region] ?? "").trim(),
    accessKeyId: (env[required.accessKeyId] ?? "").trim(),
    secretAccessKey: (env[required.secretAccessKey] ?? "").trim(),
    ...(prefix === "" ? {} : { prefix }),
  };
}

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
