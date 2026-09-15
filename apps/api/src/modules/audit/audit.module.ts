import { Module } from "@nestjs/common";
import { AuditController } from "./audit.controller.ts";

@Module({ controllers: [AuditController] })
export class AuditModule {}
