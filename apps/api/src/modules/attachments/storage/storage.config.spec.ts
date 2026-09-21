import { attachmentsBackendFromEnv, STORAGE_BACKEND_VARIABLE } from "./storage.config.ts";

/**
 * The selection, and what it refuses. The refusals are the point: a misconfigured object store that
 * quietly fell back to a local directory would put a patient's scan on a server disk the operator
 * believes is empty, and nothing would say so until a restore.
 */
describe("attachmentsBackendFromEnv", () => {
  const s3 = {
    [STORAGE_BACKEND_VARIABLE]: "s3",
    ATTACHMENTS_S3_ENDPOINT: "https://obs.af-north-1.example",
    ATTACHMENTS_S3_BUCKET: "clinic-os-attachments",
    ATTACHMENTS_S3_REGION: "af-north-1",
    ATTACHMENTS_S3_ACCESS_KEY_ID: "key",
    ATTACHMENTS_S3_SECRET_ACCESS_KEY: "secret",
  };

  test("defaults to the local filesystem, so an existing deployment needs no new variable", () => {
    expect(attachmentsBackendFromEnv({ ATTACHMENTS_STORAGE_ROOT: "/srv/attachments" })).toEqual({
      kind: "local",
      root: "/srv/attachments",
    });
  });

  test("reads the S3 settings when the backend says s3", () => {
    expect(attachmentsBackendFromEnv(s3)).toEqual({
      kind: "s3",
      endpoint: "https://obs.af-north-1.example",
      bucket: "clinic-os-attachments",
      region: "af-north-1",
      accessKeyId: "key",
      secretAccessKey: "secret",
    });
  });

  test("carries a prefix when there is one, and omits it when there is not", () => {
    expect(attachmentsBackendFromEnv({ ...s3, ATTACHMENTS_S3_PREFIX: "attachments/" })).toMatchObject({
      prefix: "attachments/",
    });
    expect(attachmentsBackendFromEnv({ ...s3, ATTACHMENTS_S3_PREFIX: "  " })).not.toHaveProperty("prefix");
  });

  test.each(Object.keys(s3).filter((name) => name !== STORAGE_BACKEND_VARIABLE))(
    "refuses s3 with %s missing, and names it",
    (missing) => {
      const incomplete = { ...s3, [missing]: "" };
      expect(() => attachmentsBackendFromEnv(incomplete)).toThrow(missing);
    },
  );

  test("refuses a backend name it does not implement rather than guessing", () => {
    expect(() => attachmentsBackendFromEnv({ [STORAGE_BACKEND_VARIABLE]: "gcs" })).toThrow(/must be "local" or "s3"/);
  });

  test("still refuses a local backend with no root", () => {
    expect(() => attachmentsBackendFromEnv({})).toThrow(/ATTACHMENTS_STORAGE_ROOT is not set/);
  });
});
