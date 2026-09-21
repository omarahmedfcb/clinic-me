import { Logger } from "@nestjs/common";
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
 * false. **That one case** is caught and reported as "does not match", which is the only correct
 * reading of it: a password cannot match a hash that is not a hash. The alternative -- letting it
 * propagate -- turns an unauthenticatable account into a 500 on the login endpoint, which both
 * leaks that the account exists and is a worse failure than the honest answer.
 *
 * It is matched on the error's own code rather than caught wholesale. Until 2026-09-16 the catch
 * was unqualified, so every other failure -- an allocation failure above all, since Argon2id asks
 * for 19 MiB per call -- also became "wrong password": a correct credential refused with a 401, no
 * log line, no 500, nothing to find afterwards.
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
/**
 * `@node-rs/argon2`'s code for a hash string it cannot decode. Every other failure propagates.
 *
 * The two are distinguishable, which is what makes this safe to narrow:
 *
 *   unparseable hash   code "InvalidArg"      message "Decoding failed"
 *   resource failure   code "GenericFailure"  message "Memory allocation error"
 */
const UNPARSEABLE_HASH = "InvalidArg";

const logger = new Logger("verifyPasswordHash");

export async function verifyPasswordHash(passwordHash: string, plain: string): Promise<boolean> {
  try {
    return await verify(passwordHash, plain);
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === UNPARSEABLE_HASH) return false;

    /*
     * Anything else is "could not check", which is not the same claim as "does not match".
     *
     * The catch was unqualified until 2026-09-16, so a resource failure — Argon2id allocates 19 MiB
     * per call — came back as a wrong password: a correct credential refused with 401, no log line
     * and no 500. Rethrowing turns it into the loud failure it is, and the log names the cause the
     * response deliberately will not.
     */
    logger.error(
      `argon2 verify failed for a reason that is not a wrong password: ${
        (error as Error | null)?.message ?? String(error)
      }`,
    );
    throw error;
  }
}
