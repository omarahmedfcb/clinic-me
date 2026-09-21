// swc compiles named exports as non-configurable getters, so jest.spyOn on an imported namespace
// throws. jest.mock + requireActual replaces the module in Jest's registry before password.ts
// imports it, wrapping only `verify` — the same pattern auth-endpoints.integration.spec.ts uses.
jest.mock("@node-rs/argon2", () => {
  const actual = jest.requireActual("@node-rs/argon2");
  return { ...actual, verify: jest.fn(actual.verify) };
});

import { verify } from "@node-rs/argon2";
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

  /**
   * "Does not match" and "could not check" are different claims, and only one of them is a 401.
   *
   * The catch here was unqualified until 2026-09-16, so a resource failure came back as a wrong
   * password: a correct credential refused, with no log line and no 500 to find afterwards.
   */
  describe("only an unparseable hash counts as a wrong password", () => {
    const PASSWORD = "correct-horse-battery-staple";

    test("the system-actor sentinel still returns false, not an error", async () => {
      // D16: prisma/sql/06-system-actor.sql stores a deliberate non-hash so that no password can
      // ever verify against it. This is the case the catch exists for and it must not change.
      await expect(verifyPasswordHash("no-password-can-ever-match-this", PASSWORD)).resolves.toBe(false);
      await expect(verifyPasswordHash("", PASSWORD)).resolves.toBe(false);
      await expect(verifyPasswordHash("$argon2id$v=19$m=19456,t=2,p=1$!!!!$!!!!", PASSWORD)).resolves.toBe(false);
    });

    test("a resource failure THROWS rather than reporting a wrong password", async () => {
      /*
       * The error is injected, not provoked.
       *
       * Asking argon2 for an unallocatable 1 TiB does reproduce it on a developer machine — it
       * answers "Memory allocation error" at once — but on a CI runner the allocator thrashes
       * instead of refusing, and the unit suite hung until the job was cancelled after seventeen
       * minutes. What is under test is the branch, not the allocator.
       */
      const resourceFailure = Object.assign(new Error("Memory allocation error"), {
        code: "GenericFailure",
      });
      (verify as jest.Mock).mockRejectedValueOnce(resourceFailure);

      await expect(verifyPasswordHash("$argon2id$anything", PASSWORD)).rejects.toMatchObject({
        code: "GenericFailure",
      });
    });
  });
});
