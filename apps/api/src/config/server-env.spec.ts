import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { REQUIRED_SERVER_ENV, S3_SERVER_ENV } from "./server-env.ts";

/**
 * Keeps the list honest in the direction a list rots: naming a variable nothing reads.
 *
 * The other direction — code reading a variable the list forgets — is what
 * `scripts/check-server-compose.mjs` and the API's own refusals cover. A list is only worth having
 * if something fails when it drifts, and this is that something.
 */
function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const full = path.join(directory, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return full.endsWith(".ts") && !full.endsWith(".spec.ts") ? [full] : [];
  });
}

describe("the deployment's required environment", () => {
  const src = path.resolve(__dirname, "..");
  const corpus = sourceFiles(src)
    .map((file) => readFileSync(file, "utf8"))
    .join("\n");

  test.each([...REQUIRED_SERVER_ENV.map((variable) => variable.name), ...S3_SERVER_ENV])(
    "%s is actually read by the source",
    (name) => {
      expect(corpus).toContain(`"${name}"`);
    },
  );

  test("each entry says where it is read, and that file exists", () => {
    for (const variable of REQUIRED_SERVER_ENV) {
      expect(() => statSync(path.resolve(src, "..", variable.readBy))).not.toThrow();
    }
  });

  test("names are unique", () => {
    const names = [...REQUIRED_SERVER_ENV.map((variable) => variable.name), ...S3_SERVER_ENV];
    expect(new Set(names).size).toBe(names.length);
  });
});
