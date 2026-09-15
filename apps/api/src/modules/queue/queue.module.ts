import { Module } from "@nestjs/common";
import { QueueController } from "./queue.controller.ts";

/**
 * The controller only. The service is a set of plain exported functions rather than an injectable
 * provider, for the reason `PatientsModule` records: the AI tool layer (ARCHITECTURE.md §12) calls
 * it without a Nest container, and an `@Injectable()` service would make the tool registry
 * construct a module to reach it.
 */
@Module({ controllers: [QueueController] })
export class QueueModule {}
