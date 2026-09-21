import { Module } from "@nestjs/common";
import { ThrottlerModule } from "@nestjs/throttler";
import { BotController } from "./bot.controller.ts";
import { BotAuthController, BotCredentialController } from "./bot-credential.controller.ts";
import { BOT_THROTTLERS } from "./bot-throttle.ts";
import { ThrottlingModule } from "../../common/throttling.module.ts";

/** The controllers, plus the throttlers their routes name — configured beside the routes they protect. */
@Module({
  imports: [ThrottlingModule],
  controllers: [BotController, BotCredentialController, BotAuthController],
})
export class BotModule {}
