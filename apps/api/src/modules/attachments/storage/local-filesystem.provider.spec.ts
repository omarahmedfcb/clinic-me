import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalFilesystemStorageProvider } from "./local-filesystem.provider.ts";
import { ObjectAlreadyExists, ObjectNotFound } from "./storage-provider.ts";
import { storageRootFromEnv, STORAGE_ROOT_VARIABLE } from "./storage.config.ts";

/**
 * The filesystem provider, against a real temporary directory.
 *
 * This is a unit spec and stays one: it touches a scratch directory it creates and removes, and it
 * imports nothing under `src/prisma/`. That last part is the rule in CLAUDE.md — one import
 * reaching `src/prisma/client.ts` would give this file a hidden dependency on `APP_DATABASE_URL`
 * and make it pass locally and fail to load on CI.
 */

const TENANT = "01a05c56-4867-7f49-b554-d60534a9bf68";
const PATIENT = "01a05c56-48e0-7892-957e-a8484a62c8b8";
const ATTACHMENT = "01a05c56-4924-7b7b-924e-cc81a84d1fd2";
const KEY = `${TENANT}/${PATIENT}/${ATTACHMENT}.pdf`;

describe("LocalFilesystemStorageProvider", () => {
  let root: string;
  let provider: LocalFilesystemStorageProvider;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "clinic-os-attachments-"));
    provider = new LocalFilesystemStorageProvider(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("stores and returns the exact bytes", async () => {
    const bytes = Buffer.from("%PDF-1.7\nnot really a pdf");
    await provider.put(KEY, bytes);
    expect(await provider.get(KEY)).toEqual(bytes);
  });

  test("writes under the configured root, in a tenant subtree", async () => {
    await provider.put(KEY, Buffer.from("x"));
    // Read through the filesystem rather than through the provider: this asserts *where* the object
    // landed, which is the part a deployment and a backup script both depend on.
    expect(await readFile(join(root, TENANT, PATIENT, `${ATTACHMENT}.pdf`), "utf8")).toBe("x");
  });

  test("refuses to overwrite an existing object", async () => {
    await provider.put(KEY, Buffer.from("original"));
    await expect(provider.put(KEY, Buffer.from("replacement"))).rejects.toBeInstanceOf(
      ObjectAlreadyExists,
    );
    // The point of refusing: the first bytes are still there.
    expect(await provider.get(KEY)).toEqual(Buffer.from("original"));
  });

  test("a missing object is ObjectNotFound, not an ENOENT leaking a path", async () => {
    await expect(provider.get(KEY)).rejects.toBeInstanceOf(ObjectNotFound);
    await expect(provider.get(KEY)).rejects.toThrow(/No stored object for key/);
    // The storage root must not appear in an error that may reach a log.
    await expect(provider.get(KEY)).rejects.not.toThrow(new RegExp(root.replace(/\\/g, "\\\\")));
  });

  describe("cannot be talked into reading outside its root", () => {
    /**
     * A file planted **outside** the root, then asked for by a key that would reach it if the key
     * were joined naively. Without the checks this is the bug: an arbitrary host file returned
     * through an authenticated endpoint.
     */
    test("a traversal key cannot read a file above the root", async () => {
      const outside = join(root, "..", `clinic-os-secret-${process.pid}.txt`);
      await writeFile(outside, "SECRET-CONTENT-MUST-NOT-BE-READABLE");
      try {
        await expect(
          provider.get(`${TENANT}/${PATIENT}/../../../clinic-os-secret-${process.pid}.txt`),
        ).rejects.toBeInstanceOf(ObjectNotFound);
      } finally {
        await rm(outside, { force: true });
      }
    });

    test.each([
      ["an absolute path", "/etc/passwd"],
      ["a Windows absolute path", "C:\\Windows\\win.ini"],
      ["a bare traversal", "../../../etc/passwd"],
      ["a key with backslashes", `${TENANT}\\${PATIENT}\\${ATTACHMENT}.pdf`],
    ])("%s is refused", async (_name, key) => {
      await expect(provider.get(key)).rejects.toBeInstanceOf(ObjectNotFound);
      await expect(provider.put(key, Buffer.from("x"))).rejects.toBeInstanceOf(ObjectNotFound);
    });

    test("a traversal key that resolves back inside the root is still refused", async () => {
      // Resolving inside is not enough to be safe: the shape is not one this system emits, and
      // admitting it would mean the allow-list is doing nothing.
      await expect(
        provider.get(`${TENANT}/${PATIENT}/../${PATIENT}/${ATTACHMENT}.pdf`),
      ).rejects.toBeInstanceOf(ObjectNotFound);
    });
  });

  describe("the root itself", () => {
    test("a relative root is refused at construction", () => {
      expect(() => new LocalFilesystemStorageProvider("./uploads")).toThrow(/absolute path/);
    });

    test("assertUsable creates the root when it does not exist yet", async () => {
      const nested = join(root, "not-created-yet");
      const fresh = new LocalFilesystemStorageProvider(nested);
      await fresh.assertUsable();
      await fresh.put(KEY, Buffer.from("x"));
      expect(await fresh.get(KEY)).toEqual(Buffer.from("x"));
    });

    test("assertUsable is idempotent against an existing directory", async () => {
      await mkdir(join(root, "already"), { recursive: true });
      const existing = new LocalFilesystemStorageProvider(join(root, "already"));
      await existing.assertUsable();
      await existing.assertUsable();
    });
  });
});

describe("storageRootFromEnv", () => {
  test("returns the configured root", () => {
    expect(storageRootFromEnv({ [STORAGE_ROOT_VARIABLE]: "/srv/clinic-os/attachments" })).toBe(
      "/srv/clinic-os/attachments",
    );
  });

  test.each([
    ["unset", {}],
    ["empty", { [STORAGE_ROOT_VARIABLE]: "" }],
    ["whitespace", { [STORAGE_ROOT_VARIABLE]: "   " }],
  ])("throws when %s, rather than defaulting to somewhere nobody chose", (_name, env) => {
    expect(() => storageRootFromEnv(env)).toThrow(new RegExp(STORAGE_ROOT_VARIABLE));
    expect(() => storageRootFromEnv(env)).toThrow(/no default on purpose/);
  });
});
