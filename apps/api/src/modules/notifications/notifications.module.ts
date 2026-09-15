import { Module } from "@nestjs/common";
import { NotificationsController } from "./notifications.controller.ts";

/** Controller only — the service is plain functions, so the AI tool layer needs no container. */
@Module({ controllers: [NotificationsController] })
export class NotificationsModule {}
