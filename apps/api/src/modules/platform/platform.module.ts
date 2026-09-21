import { Module } from "@nestjs/common";
import { STORAGE_PROVIDER, type StorageProvider } from "../attachments/storage/storage-provider.ts";
import { createStorageProvider } from "../attachments/storage/storage.factory.ts";
import { PlatformClientFileController } from "./platform-client-file.controller.ts";
import { PlatformClinicsController } from "./platform-clinics.controller.ts";
import { PlatformOperatorsController } from "./platform-operators.controller.ts";
import { PlatformController } from "./platform.controller.ts";

/**
 * The same storage seam the attachments module wires, declared again here rather than exported from
 * there: a provider token is module-scoped in Nest, and importing `AttachmentsModule` for it would
 * pull the clinic's attachment routes into the operator's module graph. One factory each, one
 * environment variable, and the day this moves to S3 both files change together.
 */
@Module({
  controllers: [
    PlatformController,
    PlatformClinicsController,
    PlatformOperatorsController,
    PlatformClientFileController,
  ],
  providers: [
    {
      provide: STORAGE_PROVIDER,
      useFactory: (): StorageProvider => createStorageProvider(),
    },
  ],
})
export class PlatformModule {}
