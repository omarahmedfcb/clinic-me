import { Module } from "@nestjs/common";
import { ClinicalController } from "./clinical.controller.ts";
import { OpenVisitsController } from "./open-visits.controller.ts";

/**
 * The controller only. The services are plain exported functions, for the reason PatientsModule
 * records: the AI tool layer calls them without a Nest container.
 */
@Module({ controllers: [ClinicalController, OpenVisitsController] })
export class ClinicalModule {}
