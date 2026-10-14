import { Module } from "@nestjs/common";
import { ThrottlingModule } from "../../common/throttling.module.ts";
import { STORAGE_PROVIDER, type StorageProvider } from "../attachments/storage/storage-provider.ts";
import { createStorageProvider } from "../attachments/storage/storage.factory.ts";
import { VisitDocumentsController } from "./visit-documents.controller.ts";

@Module({
  imports: [ThrottlingModule],
  controllers: [VisitDocumentsController],
  providers: [{ provide: STORAGE_PROVIDER, useFactory: (): StorageProvider => createStorageProvider() }],
})
export class VisitDocumentsModule {}
