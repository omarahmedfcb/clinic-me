import {
  Body,
  ConflictException,
  Controller,
  Get,
  NotFoundException,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";
import { IsString, IsUUID, Length, Matches } from "class-validator";
import { Throttle } from "@nestjs/throttler";
import { RetryAfterThrottlerGuard } from "../../common/throttlers.ts";
import { actorContext } from "../../common/actor-context.ts";
import { AuthGuard, type AuthenticatedRequest } from "../../common/auth.guard.ts";
import { PermissionGuard } from "../../common/permission.guard.ts";
import { RequirePermission } from "../../common/require-permission.decorator.ts";
import { refusal } from "../../common/refusals.ts";
import { TenantGuard } from "../../common/tenant.guard.ts";
import { issueAccessToken } from "../auth/jwt.ts";
import { checkWebhookAddress, resolveHostname } from "./webhook-address.ts";
import {
  authenticateBotCredential,
  describeBotCredential,
  issueBotCredential,
  revokeBotCredential,
  setWebhookUrl,
} from "./bot-credential.service.ts";

export class BotWebhookDto {
  // HTTPS, and the database says so too: a reminder over plain HTTP carries a patient's first name
  // and appointment time past every hop between us and them.
  @IsString()
  @Matches(/^https:\/\/\S+$/)
  @Length(8, 2048)
  url!: string;
}

export class BotTokenDto {
  @IsUUID()
  credentialId!: string;

  @IsString()
  @Length(16, 256)
  secret!: string;
}

/**
 * The clinic's half of the bot credential: issue, revoke, and see whether one exists.
 *
 * `clinicSettings.manage`, so an ADMIN or OWNER — the same capability that governs the rest of the
 * clinic's configuration. A receptionist cannot hand a clinic's patient data to an external system,
 * and a doctor cannot either.
 */
@Controller("clinic/bot-credential")
@UseGuards(AuthGuard, TenantGuard, PermissionGuard)
export class BotCredentialController {
  private caller(request: AuthenticatedRequest) {
    return { tenantId: request.authClaims.tenantId, actor: actorContext.getOrThrow() };
  }

  /** The live credential, or `null`. Never the secret: it does not exist here to return. */
  @Get()
  @RequirePermission("clinicSettings.manage")
  async current(@Req() request: AuthenticatedRequest) {
    return { credential: await describeBotCredential(this.caller(request)) };
  }

  /**
   * Issues one, and shows the secret **once**.
   *
   * There is no route that reads it back, by design: what is stored is an Argon2id hash, so a second
   * look is not a permission we chose to withhold — it is a value nobody has. Losing it means
   * revoking and issuing again, which is one click and leaves an audit trail of both acts.
   */
  @Post()
  @RequirePermission("clinicSettings.manage")
  async issue(@Req() request: AuthenticatedRequest) {
    const result = await issueBotCredential(this.caller(request), new Date());
    if (result.ok) {
      return {
        credentialId: result.credentialId,
        secret: result.secret,
        // The webhook's signing secret, issued with the credential and dying with it. Shown here
        // and nowhere else: `GET` returns the URL we call, never the secret we sign with.
        webhookSecret: result.webhookSecret,
        shownOnce: "This secret is not stored and cannot be shown again. Revoke and re-issue if it is lost.",
      };
    }
    throw new ConflictException(
      refusal("ALREADY_ISSUED", { resource: "botCredential" }),
    );
  }

  /** Where the clinic's bot listens for reminders and confirmations. HTTPS only, by the DTO and a CHECK. */
  @Post("webhook")
  @RequirePermission("clinicSettings.manage")
  async webhook(@Req() request: AuthenticatedRequest, @Body() body: BotWebhookDto) {
    const result = await setWebhookUrl(this.caller(request), body.url);
    if (result.ok) return { url: body.url };
    throw new NotFoundException(refusal("NOT_FOUND", { resource: "botCredential" }));
  }

  /** Revokes the live credential and suspends the bot's membership, so a live token dies too. */
  @Post("revoke")
  @RequirePermission("clinicSettings.manage")
  async revoke(@Req() request: AuthenticatedRequest) {
    const result = await revokeBotCredential(this.caller(request), new Date());
    if (result.ok) return { revoked: true };
    throw new NotFoundException(refusal("NOT_FOUND", { resource: "botCredential" }));
  }
}

/**
 * Where the bot exchanges its credential for an access token. **Unauthenticated by construction**:
 * this is the door, so it cannot be behind the lock.
 *
 * Throttled on the credential id rather than the IP: a bot runs from a handful of addresses and a
 * per-IP limit would either be uselessly wide or would take a clinic offline because another
 * clinic's bot shares a host. The tracker below is the whole reason this controller is separate.
 */
@Controller("bot/auth")
export class BotAuthController {
  @Post("token")
  @UseGuards(RetryAfterThrottlerGuard)
  @Throttle({ "bot-credential": { limit: 10, ttl: 60_000 } })
  async token(@Body() body: BotTokenDto) {
    const bot = await authenticateBotCredential(body.credentialId, body.secret, new Date());
    // One answer for a wrong secret, a revoked credential and an id that never existed.
    if (bot === null) throw new UnauthorizedException(refusal("INVALID_CREDENTIAL", { resource: "botCredential" }));

    const accessToken = await issueAccessToken({
      sub: bot.userId,
      membershipId: bot.membershipId,
      tenantId: bot.tenantId,
      role: "AI_AGENT",
    });
    return { accessToken, tokenType: "Bearer" };
  }
}
