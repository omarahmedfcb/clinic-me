import { Algorithm, hash, verify } from "@node-rs/argon2";

/**
 * Argon2id per docs/PHASE-1.md's authentication requirement and OWASP's password-storage
 * recommendation. Explicit even though Argon2id is @node-rs/argon2's own default -- a reader
 * should not have to check the library's docs to know this is a deliberate security choice, not
 * an incidental one. memoryCost/timeCost/parallelism are left at the library's defaults (19 MiB,
 * 2 iterations, 1 thread), which already sit at OWASP's current baseline recommendation.
 */
export async function hashPassword(plain: string): Promise<string> {
  return hash(plain, { algorithm: Algorithm.Argon2id });
}

/**
 * Argon2 hash strings are self-describing (algorithm, version, memory/time cost, and salt are
 * all encoded in the string itself), so verification needs no options to match against whatever
 * hashPassword() was called with -- including if those parameters change in the future for newly
 * hashed passwords while old hashes stay verifiable.
 *
 * A stored value that is not a parseable Argon2 encoding makes verify() throw rather than return
 * false. That is caught and reported as "does not match", which is the only correct reading of
 * it: a password cannot match a hash that is not a hash. The alternative -- letting it propagate
 * -- turns an unauthenticatable account into a 500 on the login endpoint, which both leaks that
 * the account exists and is a worse failure than the honest answer.
 *
 * This is load-bearing, not defensive padding. The system actor
 * (prisma/sql/06-system-actor.sql) stores exactly such a sentinel, deliberately, so that no
 * password can ever verify against it -- see SCHEMA-DECISIONS.md D16 and the test in
 * test/integration/audit-triggers.integration.spec.ts.
 *
 * It does not reopen the timing side-channel getDummyHash() in user-lookup.ts closes. That guards
 * "does this identifier exist", and every real user -- found or not -- still costs one full
 * Argon2 verify. Only a stored non-hash returns early, and the only account with one is a single,
 * well-known, published id.
 */
export async function verifyPasswordHash(passwordHash: string, plain: string): Promise<boolean> {
  try {
    return await verify(passwordHash, plain);
  } catch {
    return false;
  }
}
