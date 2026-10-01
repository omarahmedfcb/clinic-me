import { Module } from "@nestjs/common";
import { ComplaintsController } from "./complaints.controller.ts";

@Module({ controllers: [ComplaintsController] })
export class ComplaintsModule {}
