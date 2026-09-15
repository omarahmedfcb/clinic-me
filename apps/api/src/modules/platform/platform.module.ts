import { Module } from "@nestjs/common";
import { PlatformController } from "./platform.controller.ts";

@Module({ controllers: [PlatformController] })
export class PlatformModule {}
