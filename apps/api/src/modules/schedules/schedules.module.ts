import { Module } from "@nestjs/common";
import { SchedulesController } from "./schedules.controller.ts";

/** Controller only — the service is plain functions, so the AI tool layer needs no container. */
@Module({ controllers: [SchedulesController] })
export class SchedulesModule {}
