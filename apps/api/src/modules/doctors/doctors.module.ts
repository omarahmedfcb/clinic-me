import { Module } from "@nestjs/common";
import { DoctorsController } from "./doctors.controller.ts";

/** Controller only — the service is plain functions, so the AI tool layer needs no container. */
@Module({ controllers: [DoctorsController] })
export class DoctorsModule {}
