import { deployedCommit } from "../../src/config/deployed-commit.ts";

const SHA = "0123456789abcdef0123456789abcdef01234567";

describe("DEPLOYED_COMMIT", () => {
  test("unset or empty is unknown outside production, not a guess", () => {
    expect(deployedCommit({})).toBeNull();
    expect(deployedCommit({ DEPLOYED_COMMIT: "", NODE_ENV: "test" })).toBeNull();
    expect(deployedCommit({ NODE_ENV: "development" })).toBeNull();
  });

  test("unset or empty in production refuses boot: a forgotten prefix is a refused deploy", () => {
    expect(() => deployedCommit({ NODE_ENV: "production" })).toThrow("DEPLOYED_COMMIT is unset");
    expect(() => deployedCommit({ NODE_ENV: "production", DEPLOYED_COMMIT: "" })).toThrow("DEPLOYED_COMMIT is unset");
    expect(deployedCommit({ NODE_ENV: "production", DEPLOYED_COMMIT: SHA })).toBe(SHA);
  });

  test("a full commit hash is reported as given", () => {
    expect(deployedCommit({ DEPLOYED_COMMIT: SHA })).toBe(SHA);
  });

  test.each([["a short hash", SHA.slice(0, 7)], ["a tag", "v1.4.0"], ["upper case", SHA.toUpperCase()], ["a trailing newline", `${SHA}\n`]])(
    "%s refuses, so the console never reports a version that is not running",
    (_name, value) => {
      expect(() => deployedCommit({ DEPLOYED_COMMIT: value })).toThrow("full 40-character commit hash");
    },
  );
});
