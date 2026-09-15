/**
 * The seam. `PHASE-4.md` Q11, `ARCHITECTURE.md` §19.
 *
 * The founder's ruling was the local filesystem *behind an interface*, and his reasoning was that
 * **the interface is the deliverable**: "it's a dev and pilot deployment on one machine; the
 * interface is what makes moving cheap later." So this file is the point of the storage work, and
 * `local-filesystem.provider.ts` is one implementation of it.
 *
 * ## What is deliberately absent from this interface
 *
 * **No `url()`, and no method that could grow into one.** Attachments are never served from a
 * public path, a static directory, or a redirect to storage — they are streamed back through the
 * API under `visits.readContent`, which puts a doctor-only file behind the same gate as the notes
 * it belongs to. An interface with a `getUrl()` on it invites a caller to hand that URL to a
 * browser, and the gate is then decoration. The absence is the design.
 *
 * **No `delete()`.** Medical records are never hard-deleted (CLAUDE.md); archiving sets
 * `attachments.archived_at` and the stored object stays exactly where it was. A provider that
 * cannot delete cannot be talked into deleting by a future caller that means well. If a retention
 * policy ever needs one, it should arrive as a separate, explicitly-named capability with its own
 * ruling — not as a method that was already sitting here.
 *
 * ## The contract for an implementer
 *
 * - `put` is create-only. Keys are derived from a fresh UUIDv7 per attachment, so a collision means
 *   something is badly wrong and overwriting would destroy a record: implementations must refuse.
 * - `get` throws `ObjectNotFound` for a key that is absent, and must not distinguish "never
 *   existed" from "not readable" to its caller.
 * - Neither method interprets the key. It is opaque, and `isSafeStorageKey` is what decides whether
 *   it is well-formed.
 */

export class ObjectNotFound extends Error {
  constructor(key: string) {
    // The key, not a path: an error that escapes into a log should not disclose the storage root.
    super(`No stored object for key ${key}.`);
    this.name = "ObjectNotFound";
  }
}

export class ObjectAlreadyExists extends Error {
  constructor(key: string) {
    super(`A stored object already exists for key ${key}.`);
    this.name = "ObjectAlreadyExists";
  }
}

export interface StorageProvider {
  /** Writes bytes at `key`. Refuses if `key` is already taken. */
  put(key: string, bytes: Buffer): Promise<void>;

  /** The bytes at `key`. Throws `ObjectNotFound` if there are none. */
  get(key: string): Promise<Buffer>;
}

/** DI token. An interface has no runtime value to inject against. */
export const STORAGE_PROVIDER = Symbol("STORAGE_PROVIDER");
