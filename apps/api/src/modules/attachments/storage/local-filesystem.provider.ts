import { constants } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { isSafeBrandingKey } from "../domain/branding-key.ts";
import { isSafePhotoKey } from "../domain/photo-key.ts";
import { isSafeStorageKey } from "../domain/storage-key.ts";
import {
  ObjectAlreadyExists,
  ObjectNotFound,
  type StorageProvider,
} from "./storage-provider.ts";

/**
 * The one implementation, for the pilot. `PHASE-4.md` Q11.
 *
 * ## The root, and why it is required rather than defaulted
 *
 * `ATTACHMENTS_STORAGE_ROOT` has no fallback. A default — `./uploads`, `os.tmpdir()`, anything —
 * would put patient scans somewhere nobody chose: inside the repository where a later `git add -A`
 * commits them, or in a temp directory the operating system empties on reboot. Both fail silently
 * and both are discovered long afterwards. Refusing to start names the problem at deploy time,
 * which is the same argument `client.ts` makes for `APP_DATABASE_URL` and `main.ts` makes for
 * timezone data.
 *
 * Q11 also requires the root to sit **outside the repository and outside any served directory**.
 * That is a deployment fact this class cannot verify — it cannot know what Caddy serves — so
 * `docs/DEPLOY.md` carries it. What this class can do is refuse a relative path, which is the one
 * form that makes the location depend on the working directory the process happened to start in.
 */
export class LocalFilesystemStorageProvider implements StorageProvider {
  private readonly root: string;

  constructor(root: string) {
    if (!isAbsolute(root)) {
      throw new Error(
        `ATTACHMENTS_STORAGE_ROOT must be an absolute path; received "${root}". A relative root ` +
          "resolves against the process working directory, so the same configuration would store " +
          "files in a different place depending on where the service was started from.",
      );
    }
    // Normalised once so `resolvePath` compares against a canonical prefix rather than whatever
    // shape the environment variable arrived in.
    this.root = resolve(root);
  }

  /**
   * The absolute path for a key, or a throw.
   *
   * Two independent checks, and the second is not redundant. `isSafeStorageKey` says the key has
   * the shape this system emits; the prefix comparison says the resolved path is genuinely inside
   * the root. The first is an allow-list and would have to be wrong for the second to matter — but
   * "the allow-list is wrong" is exactly the situation a defence-in-depth check exists for, and
   * this one costs a string comparison. The project makes the same argument for tenant scoping:
   * a compile-time requirement backed by an independent runtime one, neither trusted alone.
   */
  private resolvePath(key: string): string {
    // Any shape this system emits: an attachment key, a branding key (Q28), or a profile photo.
    // Three validators rather than one widened regex, so no read path's guard can be loosened by
    // another's requirements — each read checks its own, and this is the last-resort path check
    // underneath all of them.
    if (!isSafeStorageKey(key) && !isSafeBrandingKey(key) && !isSafePhotoKey(key)) {
      throw new ObjectNotFound(key);
    }
    const path = resolve(join(this.root, key));
    if (path !== this.root && !path.startsWith(this.root + sep)) {
      throw new ObjectNotFound(key);
    }
    return path;
  }

  async put(key: string, bytes: Buffer): Promise<void> {
    const path = this.resolvePath(key);

    // `wx` is the create-only flag: it fails with EEXIST rather than truncating. Checking first and
    // then writing would be a race, and the thing being raced over is a patient's record.
    await mkdir(dirname(path), { recursive: true });
    try {
      await writeFile(path, bytes, { flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new ObjectAlreadyExists(key);
      }
      throw error;
    }
  }

  async get(key: string): Promise<Buffer> {
    const path = this.resolvePath(key);
    try {
      return await readFile(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new ObjectNotFound(key);
      }
      throw error;
    }
  }

  /**
   * Called once at startup. A storage root that is missing or unwritable is a deployment fault, and
   * the moment to find out is before the first doctor tries to attach a scan — not at the moment
   * they do, with a patient in the room.
   */
  async assertUsable(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    try {
      await access(this.root, constants.W_OK);
    } catch {
      throw new Error(
        `ATTACHMENTS_STORAGE_ROOT "${this.root}" exists but is not writable by this process.`,
      );
    }
  }
}
