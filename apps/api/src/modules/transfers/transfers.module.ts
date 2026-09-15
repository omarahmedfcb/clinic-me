import { Module } from "@nestjs/common";
import { TransfersController } from "./transfers.controller.ts";

@Module({ controllers: [TransfersController] })
export class TransfersModule {}
