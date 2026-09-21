import { Module } from "@nestjs/common";
import { ThrottlingModule } from "../../common/throttling.module.ts";
import { WRITE_THROTTLERS } from "../../common/write-throttle.ts";
import { PatientsController } from "./patients.controller.ts";

/**
 * The controller only. The service is a set of plain exported functions rather than an injectable
 * provider, because the AI tool layer (ARCHITECTURE.md §12) calls it without a Nest container —
 * a `@Injectable()` service would make the tool registry construct a module to reach it.
 */
@Module({
  imports: [ThrottlingModule],
  controllers: [PatientsController] })
export class PatientsModule {}
