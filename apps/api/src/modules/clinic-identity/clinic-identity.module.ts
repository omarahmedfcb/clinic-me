// The clinic's printed identity. Q28. Shares the one `StorageProvider` the attachments module wires.
// A second provider would be a second thing to point at S3 the day that ruling changes.

import { Module } from "@nestjs/common";
import { ClinicIdentityController } from "./clinic-identity.controller.ts";
import { LocalFilesystemStorageProvider } from "../attachments/storage/local-filesystem.provider.ts";
import { STORAGE_PROVIDER, type StorageProvider } from "../attachments/storage/storage-provider.ts";
import { storageRootFromEnv } from "../attachments/storage/storage.config.ts";

@Module({
  controllers: [ClinicIdentityController],
  providers: [
    {
      provide: STORAGE_PROVIDER,
      useFactory: (): StorageProvider => new LocalFilesystemStorageProvider(storageRootFromEnv()),
    },
  ],
})
export class ClinicIdentityModule {}
