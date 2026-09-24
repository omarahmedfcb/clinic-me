import { Body, Controller, Post, UseGuards } from "@nestjs/common";
import { RetryAfterThrottlerGuard, ThrottleOnly } from "../../common/throttlers.ts";
import { handleWebchatMessage } from "./webchat-orchestrator.ts";
import { WEBCHAT_MESSAGE_THROTTLER } from "./webchat-throttle.ts";
import { WebchatMessageDto } from "./webchat.dto.ts";

/**
 * The web chat's entire public surface: one route, no `AuthGuard`, no `TenantGuard` -- by
 * construction, since a patient reaching this has not logged in and never will. It runs
 * `ARCHITECTURE.md §12`'s AI tool registry behind it, under an AI_AGENT actor resolved per clinic
 * once the patient names one (`webchat-clinics.ts#resolveBotActor`), the same synthetic identity a
 * WhatsApp bot would authenticate as -- just built in-process instead of over `/bot/auth/token`,
 * because this chat runs inside the same trusted API rather than as an external developer's bot.
 */
@Controller("public/webchat")
export class WebchatController {
  @Post("message")
  @UseGuards(RetryAfterThrottlerGuard)
  @ThrottleOnly(WEBCHAT_MESSAGE_THROTTLER, 30, 60_000)
  async message(@Body() body: WebchatMessageDto) {
    return handleWebchatMessage(body.sessionId, body.message);
  }
}
