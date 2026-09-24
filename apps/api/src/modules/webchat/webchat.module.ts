import { Module } from "@nestjs/common";
import { WebchatController } from "./webchat.controller.ts";

@Module({ controllers: [WebchatController] })
export class WebchatModule {}
