// The operator's messages to clinic admins (step 6.4): send to one clinic or all, and read the history. Console screen: step 9.
import { Body, Controller, Get, NotFoundException, Post, UseGuards } from "@nestjs/common";
import { IsOptional, IsString, IsUUID, Matches, MaxLength } from "class-validator";
import { actorContext } from "../../common/actor-context.ts";
import { refusal } from "../../common/refusals.ts";
import { recordOperatorRead } from "./platform-audit.ts";
import { listSentMessages, sendOperatorMessage } from "./platform-messages.ts";
import { PlatformAuthGuard } from "./platform.guard.ts";

export class SendOperatorMessageDto {
  @IsString() @MaxLength(4000) @Matches(/\S/) body!: string;
  /** Absent: every active clinic. */
  @IsOptional() @IsUUID() tenantId?: string;
}

@Controller("platform/messages")
@UseGuards(PlatformAuthGuard)
export class PlatformMessagesController {
  @Get()
  async history() {
    const actor = actorContext.getOrThrow();
    const messages = await listSentMessages(actor);
    await recordOperatorRead(actor, { entityType: "operator_messages", entityId: actor.userId, what: `message history (${messages.length})` });
    return { messages };
  }

  @Post()
  async send(@Body() body: SendOperatorMessageDto) {
    const result = await sendOperatorMessage(actorContext.getOrThrow(), body);
    if (!result.ok) throw new NotFoundException(refusal(result.code, result.params));
    return result.value;
  }
}
