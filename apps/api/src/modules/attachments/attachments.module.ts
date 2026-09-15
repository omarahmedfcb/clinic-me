import { Module, type OnApplicationBootstrap } from "@nestjs/common";
import { Inject } from "@nestjs/common";
import { AttachmentsController } from "./attachments.controller.ts";
import { AttachmentsSummaryController } from "./attachments-summary.controller.ts";
import { LocalFilesystemStorageProvider } from "./storage/local-filesystem.provider.ts";
import { STORAGE_PROVIDER, type StorageProvider } from "./storage/storage-provider.ts";
import { storageRootFromEnv } from "./storage/storage.config.ts";

/**
 * Wires the one `StorageProvider` implementation. `PHASE-4.md` Q11.
 *
 * **The day this moves to S3, this file is the change** — a different class here and a different
 * environment variable, with nothing above it altered. That is what the founder's ruling bought,
 * and it is the reason the provider is injected against a token rather than imported directly by
 * the service.
 *
 * The root is read here, at construction, rather than inside the provider: a factory is where an
 * environment variable belongs, and `storage.config.ts` stays free of module-scope reads so a unit
 * spec can import it without needing an environment (CLAUDE.md).
 */
@Module({
  controllers: [AttachmentsController, AttachmentsSummaryController],
  providers: [
    {
      provide: STORAGE_PROVIDER,
      useFactory: (): StorageProvider =>
        new LocalFilesystemStorageProvider(storageRootFromEnv()),
    },
  ],
})
export class AttachmentsModule implements OnApplicationBootstrap {
  constructor(@Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider) {}

  /**
   * Proves the storage root is real and writable at boot.
   *
   * The alternative is finding out on the first upload, which happens with a patient in the room
   * and presents as "the app is broken" rather than "a directory is missing". This is the same
   * argument `main.ts` makes for refusing to start without timezone data: a service that cannot do
   * its job should say so at startup, not at the moment somebody needs it.
   */
  async onApplicationBootstrap(): Promise<void> {
    if (this.storage instanceof LocalFilesystemStorageProvider) {
      await this.storage.assertUsable();
    }
  }
}
