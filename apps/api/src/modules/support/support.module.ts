import { Module } from "@nestjs/common";
import { SupportSessionsController } from "./support-sessions.controller.ts";

@Module({ controllers: [SupportSessionsController] })
export class SupportModule {}
