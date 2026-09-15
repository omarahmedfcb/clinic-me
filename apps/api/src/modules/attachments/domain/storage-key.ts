import { ACCEPTED } from "./sniff.ts";

/**
 * How a stored object is addressed. `PHASE-4.md` Q11.
 *
 * Pure — no filesystem, no clock, no id generation. The attachment id is passed in rather than
 * minted here, for the reason CLAUDE.md gives about reproducibility: a function that generates
 * part of its own output cannot be checked against an expected value.
 *
 * ## The key is derived, never supplied
 *
 * `attachments.storage_key` is built from ids the server already holds and an extension decided by
 * sniffing the content. **The uploaded filename contributes nothing to it.** That is the whole
 * defence against path traversal, and it is a structural one: there is no code path from a caller's
 * bytes to a path segment, so `../../etc/passwd` as a filename is not a case to be escaped — it is
 * a case that never reaches a path at all. The original name is kept in `attachments.file_name`,
 * which is a column, not a location.
 *
 * `isSafeStorageKey` exists anyway, and the local provider calls it on the way back *out*. Keys
 * are read from the database, and a database is a place values can arrive from a restore, a
 * migration, or a future writer that does not use this function. The check is cheap and the thing
 * it prevents is reading an arbitrary file off the host.
 */

/** Tenant first, so one tenant's objects are a subtree that can be counted, moved or destroyed. */
export function storageKeyFor(input: {
  tenantId: string;
  patientId: string;
  attachmentId: string;
  extension: string;
}): string {
  return `${input.tenantId}/${input.patientId}/${input.attachmentId}.${input.extension}`;
}

/**
 * A key this system could have produced: three slash-separated segments of hyphenated hex, and an
 * extension **from the accepted set** — not merely something extension-shaped.
 *
 * Deliberately an allow-list of the exact shape rather than a scan for `..`. A deny-list has to
 * anticipate every encoding of the thing it forbids — `..`, `%2e%2e`, a backslash on Windows, a
 * leading `/` making the join absolute — and misses the one nobody thought of. This pattern admits
 * only what `storageKeyFor` emits, so anything else is refused without needing to be understood.
 *
 * The extensions come from `ACCEPTED` rather than being spelled again here. A first draft matched
 * `[a-z]{2,4}`, which is extension-*shaped* and admitted `.exe` — caught by `storage-key.spec.ts`
 * before it existed anywhere else. Deriving the alternation means the sniffer's list and this one
 * cannot drift apart, which is the failure a second hand-maintained copy would eventually produce.
 */
const SAFE_KEY = new RegExp(
  `^[0-9a-f-]{36}/[0-9a-f-]{36}/[0-9a-f-]{36}\\.(?:${Object.values(ACCEPTED).join("|")})$`,
);

export function isSafeStorageKey(key: string): boolean {
  return SAFE_KEY.test(key);
}
