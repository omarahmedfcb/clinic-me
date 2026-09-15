import { hashPassword, verifyPasswordHash } from "./password.ts";

describe("password hashing", () => {
  test("produces an Argon2id hash", async () => {
    const hash = await hashPassword("correct-horse-battery-staple");
    expect(hash.startsWith("$argon2id$")).toBe(true);
  });

  test("two hashes of the same password differ (salted)", async () => {
    const [a, b] = await Promise.all([hashPassword("same-password"), hashPassword("same-password")]);
    expect(a).not.toBe(b);
  });

  test("verifies the correct password", async () => {
    const hash = await hashPassword("correct-horse-battery-staple");
    await expect(verifyPasswordHash(hash, "correct-horse-battery-staple")).resolves.toBe(true);
  });

  test("rejects an incorrect password", async () => {
    const hash = await hashPassword("correct-horse-battery-staple");
    await expect(verifyPasswordHash(hash, "wrong-password")).resolves.toBe(false);
  });
});
