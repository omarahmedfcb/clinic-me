import { Module, type OnApplicationBootstrap } from "@nestjs/common";
import { Inject } from "@nestjs/common";
import { ThrottlerModule } from "@nestjs/throttler";
import { WRITE_THROTTLERS } from "../../common/write-throttle.ts";
import { AttachmentsController } from "./attachments.controller.ts";
import { AttachmentsSummaryController } from "./attachments-summary.controller.ts";
import { STORAGE_PROVIDER, type StorageProvider } from "./storage/storage-provider.ts";
import { createStorageProvider } from "./storage/storage.factory.ts";
import { ThrottlingModule } from "../../common/throttling.module.ts";

/**
 * Wires the one `StorageProvider` implementation. `PHASE-4.md` Q11.
 *
 * **That day came on 2026-09-18**, and it cost this line: `createStorageProvider()` reads
 * `ATTACHMENTS_STORAGE_BACKEND` and returns the filesystem provider or the S3 one. Nothing above it
 * changed, which is what the founder's ruling bought.
 *
 * The environment is read in the factory rather than inside a provider: a factory is where an
 * environment variable belongs, and `storage.config.ts` stays free of module-scope reads so a unit
 * spec can import it without needing an environment (CLAUDE.md).
 */
@Module({
  imports: [ThrottlingModule],
  controllers: [AttachmentsController, AttachmentsSummaryController],
  providers: [
    {
      provide: STORAGE_PROVIDER,
      useFactory: (): StorageProvider =>
        createStorageProvider(),
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
    await this.storage.assertUsable();
  }
}
