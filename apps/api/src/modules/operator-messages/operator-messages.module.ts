import { Module } from "@nestjs/common";
import { OperatorMessagesController } from "./operator-messages.controller.ts";

@Module({ controllers: [OperatorMessagesController] })
export class OperatorMessagesModule {}
