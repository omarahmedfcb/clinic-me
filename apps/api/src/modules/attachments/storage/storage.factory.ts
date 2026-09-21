// Chooses the storage backend from the environment. One factory, so four modules cannot drift apart.

import { LocalFilesystemStorageProvider } from "./local-filesystem.provider.ts";
import { S3StorageProvider } from "./s3.provider.ts";
import type { StorageProvider } from "./storage-provider.ts";
import { attachmentsBackendFromEnv } from "./storage.config.ts";

export function createStorageProvider(env: NodeJS.ProcessEnv = process.env): StorageProvider {
  const settings = attachmentsBackendFromEnv(env);
  return settings.kind === "local"
    ? new LocalFilesystemStorageProvider(settings.root)
    : new S3StorageProvider(settings);
}
