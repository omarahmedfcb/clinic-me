import { Module } from "@nestjs/common";
import { ServicesController } from "./services.controller.ts";

/** Controller only — the service is plain functions, so the AI tool layer needs no container. */
@Module({ controllers: [ServicesController] })
export class ServicesModule {}
