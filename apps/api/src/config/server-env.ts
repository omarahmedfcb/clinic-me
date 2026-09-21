// What a deployed API must be given. One list, read by the boot-time check and by the compose guard,
// so a variable cannot be required by the code and absent from the file that starts the container.

export interface RequiredVariable {
  name: string;
  /** Where it is read, so a reader can check this list against the code rather than trusting it. */
  readBy: string;
  /**
   * `boot` refuses to start without it. `deferred` is read the first time something needs it, which
   * is the dangerous kind: the container starts, the clinic uses it, and the failure arrives mid-day.
   * Compose gives both `:?` so the difference stops mattering on a server.
   */
  when: "boot" | "deferred";
}

export const REQUIRED_SERVER_ENV: readonly RequiredVariable[] = [
  { name: "APP_DATABASE_URL", readBy: "src/prisma/client.ts", when: "boot" },
  { name: "JWT_SECRET", readBy: "src/modules/auth/jwt.ts", when: "boot" },
  {
    name: "SLOT_TOKEN_SECRET",
    readBy: "src/modules/appointments/slot-token.ts",
    when: "deferred",
  },
  {
    name: "ATTACHMENTS_STORAGE_BACKEND",
    readBy: "src/modules/attachments/storage/storage.config.ts",
    when: "boot",
  },
  {
    name: "ATTACHMENTS_STORAGE_ROOT",
    readBy: "src/modules/attachments/storage/storage.config.ts",
    when: "boot",
  },
] as const;

/** The S3 settings, required only when the backend is `s3` — the config module refuses without them. */
export const S3_SERVER_ENV: readonly string[] = [
  "ATTACHMENTS_S3_ENDPOINT",
  "ATTACHMENTS_S3_BUCKET",
  "ATTACHMENTS_S3_REGION",
  "ATTACHMENTS_S3_ACCESS_KEY_ID",
  "ATTACHMENTS_S3_SECRET_ACCESS_KEY",
] as const;
