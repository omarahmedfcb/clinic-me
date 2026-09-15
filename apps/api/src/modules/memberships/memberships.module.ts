// Profile photos put a `StorageProvider` in here too. Same provider the attachments and identity
// modules wire, for the reason that one states: a second is a second thing to point at S3 later.

import { Module } from "@nestjs/common";
import { MembershipsController } from "./memberships.controller.ts";
import { StaffController } from "./staff.controller.ts";
import { LocalFilesystemStorageProvider } from "../attachments/storage/local-filesystem.provider.ts";
import { STORAGE_PROVIDER, type StorageProvider } from "../attachments/storage/storage-provider.ts";
import { storageRootFromEnv } from "../attachments/storage/storage.config.ts";

@Module({
  controllers: [MembershipsController, StaffController],
  providers: [
    {
      provide: STORAGE_PROVIDER,
      useFactory: (): StorageProvider => new LocalFilesystemStorageProvider(storageRootFromEnv()),
    },
  ],
})
export class MembershipsModule {}
