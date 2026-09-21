import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Post,
  Req,
  UnauthorizedException,
  UnprocessableEntityException,
  UseGuards,
} from "@nestjs/common";
import { IsString, Matches, MaxLength } from "class-validator";
import { SkipThrottle, ThrottlerGuard } from "@nestjs/throttler";
import { actorContext } from "../../common/actor-context.ts";
import { refusal } from "../../common/refusals.ts";
import { SKIP_PASSWORD_THROTTLER } from "../auth/auth-throttle.ts";
import { LoginDto } from "../auth/auth.dto.ts";
import { normalisePhone, loginCountry } from "../auth/phone.ts";
import { verifyCredentials } from "../auth/user-lookup.ts";
import {
  beginTotpEnrolment,
  beginTotpReplacement,
  confirmTotpEnrolment,
  confirmTotpReplacement,
  consumeRecoveryCode,
  countRecoveryCodes,
  issueRecoveryCodesAtEnrolment,
  regenerateRecoveryCodes,
  verifySecondFactor,
} from "./platform-operators.ts";
import { recordPlatformAction } from "./platform-audit.ts";
import { issuePlatformToken } from "./platform-token.ts";
import { operatorTotpRequired } from "./totp-policy.ts";
import { PendingPlatformGuard, type PendingPlatformRequest } from "./platform-pending.guard.ts";
import { PlatformAuthGuard, type PlatformRequest } from "./platform.guard.ts";

/** The same sentence for every way of failing to sign in. */
const INVALID_CREDENTIALS = "Invalid credentials.";

export class TotpCodeDto {
  /** Six digits. Spaces are stripped by the verifier, so a pasted `123 456` is accepted. */
  @IsString() @Matches(/^[\d\s]{6,8}$/) totpCode!: string;
}

export class RecoveryCodeDto {
  /** Loose on purpose: case and separators are normalised, and shape is not a refusal the caller sees. */
  @IsString() @MaxLength(32) recoveryCode!: string;
}

export class ReplaceTotpDto {
  @IsString() @MaxLength(200) password!: string;
}

export class RegenerateRecoveryCodesDto {
  @IsString() @MaxLength(200) password!: string;
  @IsString() @Matches(/^[\d\s]{6,8}$/) totpCode!: string;
}

/**
 * The operator's surface — pilot-readiness 0a, with the second factor added 2026-09-15.
 *
 * **It reads no tenant-scoped row, ever.** Nothing here calls `withTenant`, so
 * `app.current_tenant_id` is never bound and every RLS policy on every clinical and financial table
 * evaluates false. That is a property of not having a tenant, and
 * `platform-isolation.integration.spec.ts` holds it by querying those tables from an operator's
 * session and requiring zero rows.
 *
 * **Signing in is two steps.** The password buys a five-minute `pending` token that opens only the
 * enrolment and challenge routes below; `PlatformAuthGuard` demands a `full` one, so every route
 * added later is behind the second factor by default rather than by being remembered.
 */
@Controller("platform")
export class PlatformController {
  /**
   * Throttled like the clinic login, and for the same reason: Argon2id is deliberately slow, so an
   * unthrottled verify is a cheap way to make the server do expensive work.
   */
  @Post("login")
  @HttpCode(200)
  @UseGuards(ThrottlerGuard)
  @SkipThrottle(SKIP_PASSWORD_THROTTLER)
  async login(
    @Body() body: LoginDto,
  ): Promise<{
    pendingToken?: string;
    accessToken?: string;
    fullName: string;
    totpEnrolled: boolean;
    totpRequired: boolean;
  }> {
    // No early return, matching the clinic login: an unparseable identifier costs the same verify
    // as a real one, so timing does not distinguish them.
    const identifier = normalisePhone(body.identifier, loginCountry()) ?? body.identifier;
    const user = await verifyCredentials(identifier, body.password);

    // **The flag is checked here and again on every request** (see `PlatformAuthGuard`). A clinic
    // account that is not an operator gets the same answer as a wrong password: whether an account
    // exists and merely lacks the flag is not something an unauthenticated caller should learn.
    if (!user || !user.isPlatformAdmin) throw new UnauthorizedException(INVALID_CREDENTIALS);

    /*
     * **The only path that mints a `full` token from a password alone**, and it cannot exist in
     * production: `assertOperatorTotpAllowed` refuses to boot with `OPERATOR_TOTP=off` when
     * `NODE_ENV=production`, so this branch is unreachable on a live deployment by construction
     * rather than by a check somebody has to remember here.
     *
     * It exists because the second factor blocked a review on 2026-09-15: a reviewer with no
     * authenticator could not satisfy the code prompt, and the enrolment screen sat behind it.
     */
    if (!operatorTotpRequired()) {
      return {
        accessToken: await issuePlatformToken(user.id, "full"),
        fullName: user.fullName,
        totpEnrolled: user.totpConfirmedAt !== null,
        totpRequired: false,
      };
    }

    // Otherwise never a `full` token from here. The password alone opens nothing, which is what
    // "2FA required for every operator" means when it is enforced rather than configured.
    return {
      pendingToken: await issuePlatformToken(user.id, "pending"),
      fullName: user.fullName,
      totpEnrolled: user.totpConfirmedAt !== null,
      totpRequired: true,
    };
  }

  /**
   * Hands over a fresh secret for an account that has none — the first sign-in, or after an owner
   * has reset a lost authenticator.
   *
   * The secret leaves the server exactly once, to the holder of a token that has already passed the
   * password. Refused outright for an account that already has a confirmed factor, so this cannot
   * become a way to replace somebody's authenticator by visiting a URL.
   */
  @Post("totp/enrol")
  @HttpCode(200)
  @UseGuards(PendingPlatformGuard)
  async enrol(@Req() request: PendingPlatformRequest): Promise<{ secretBase32: string; otpauthUri: string }> {
    const result = await beginTotpEnrolment(actorContext.getOrThrow(), request.pendingOperator.userId);
    if (!result.ok) throw new UnprocessableEntityException(refusal(result.code, result.params));
    return result.value;
  }

  /** Proves the authenticator was imported, and turns the pending token into a usable one. */
  @Post("totp/confirm")
  @HttpCode(200)
  @UseGuards(PendingPlatformGuard)
  async confirm(
    @Req() request: PendingPlatformRequest,
    @Body() body: TotpCodeDto,
  ): Promise<{ accessToken: string; fullName: string; recoveryCodes: string[] }> {
    const result = await confirmTotpEnrolment(
      actorContext.getOrThrow(),
      request.pendingOperator.userId,
      body.totpCode,
      new Date(),
    );
    if (!result.ok) throw new UnprocessableEntityException(refusal(result.code, result.params));

    // Issued here and returned once. There is no route that reads them back: the plaintext exists
    // in this response and nowhere else, which is the property that makes hashing them worth doing.
    const recoveryCodes = await issueRecoveryCodesAtEnrolment(
      actorContext.getOrThrow(),
      request.pendingOperator.userId,
    );

    return {
      accessToken: await issuePlatformToken(request.pendingOperator.userId, "full"),
      fullName: request.pendingOperator.fullName,
      recoveryCodes,
    };
  }

  /**
   * Signs in with a recovery code when the authenticator is gone.
   *
   * Throttled exactly like the code challenge above, and it answers with the same sentence for a
   * wrong code, a spent one and a malformed one — at this point the caller has proved only a
   * password, which does not entitle them to learn which of the three it was.
   */
  @Post("totp/recovery")
  @HttpCode(200)
  @UseGuards(ThrottlerGuard, PendingPlatformGuard)
  @SkipThrottle(SKIP_PASSWORD_THROTTLER)
  async recovery(
    @Req() request: PendingPlatformRequest,
    @Body() body: RecoveryCodeDto,
  ): Promise<{ accessToken: string; fullName: string; recoveryCodesRemaining: number }> {
    const { userId, fullName } = request.pendingOperator;
    if (!(await consumeRecoveryCode(userId, body.recoveryCode))) {
      throw new UnauthorizedException(INVALID_CREDENTIALS);
    }

    // Its own action, not a LOGIN: this is the one path that opens the console without the second
    // factor, and "how often, and to whom" must be answerable by filtering a column.
    await recordPlatformAction(actorContext.getOrThrow(), {
      action: "OPERATOR_RECOVERY_CODE_USED",
      entityType: "users",
      entityId: userId,
      detail: { remaining: await countRecoveryCodes(userId) },
    });

    return {
      // `via: "recovery"` — this session has NOT proved possession of the second factor, only that
      // somebody holds the paper. It is the only session allowed to replace the authenticator, and
      // without that route the codes would be eight logins rather than a recovery.
      accessToken: await issuePlatformToken(userId, "full", "recovery"),
      fullName,
      recoveryCodesRemaining: await countRecoveryCodes(userId),
    };
  }

  /**
   * Starts replacing a lost authenticator. **Only in a session opened by a recovery code.**
   *
   * Without this route the codes are eight logins rather than a recovery: an operator would keep
   * signing in from the paper until it ran out, never regaining a second factor. Refused in a normal
   * session on purpose — an operator who still has their authenticator wants `recovery-codes/
   * regenerate`, which demands that authenticator and does not touch the secret.
   */
  @Post("totp/replace")
  @HttpCode(200)
  @UseGuards(ThrottlerGuard, PlatformAuthGuard)
  @SkipThrottle(SKIP_PASSWORD_THROTTLER)
  async replace(
    @Req() request: PlatformRequest,
    @Body() body: ReplaceTotpDto,
  ): Promise<{ secretBase32: string; otpauthUri: string }> {
    if (request.platformAdmin.via !== "recovery") throw new ForbiddenException(refusal("NOT_RECOVERY_SESSION", {}));

    const result = await beginTotpReplacement(actorContext.getOrThrow(), body.password);
    if (!result.ok) throw new UnauthorizedException(INVALID_CREDENTIALS);
    return result.value;
  }

  /** The new authenticator answers, and the old secret and every old code die in one transaction. */
  @Post("totp/replace/confirm")
  @HttpCode(200)
  @UseGuards(ThrottlerGuard, PlatformAuthGuard)
  @SkipThrottle(SKIP_PASSWORD_THROTTLER)
  async replaceConfirm(
    @Req() request: PlatformRequest,
    @Body() body: TotpCodeDto,
  ): Promise<{ accessToken: string; recoveryCodes: string[] }> {
    if (request.platformAdmin.via !== "recovery") throw new ForbiddenException(refusal("NOT_RECOVERY_SESSION", {}));

    const actor = actorContext.getOrThrow();
    const result = await confirmTotpReplacement(actor, body.totpCode, new Date());
    if (!result.ok) throw new UnauthorizedException(INVALID_CREDENTIALS);

    await recordPlatformAction(actor, {
      action: "OPERATOR_TOTP_REPLACED",
      entityType: "users",
      entityId: request.platformAdmin.userId,
      detail: { what: "authenticator replaced after a recovery login, recovery codes reissued" },
    });

    // A fresh token WITHOUT `via`, because the authenticator has now answered: the session stops
    // being a recovery session the moment the replacement is proved.
    return {
      accessToken: await issuePlatformToken(request.platformAdmin.userId, "full"),
      recoveryCodes: result.value.codes,
    };
  }

  /** Replaces the whole set. Both factors, because either alone may be the one that was lost. */
  @Post("recovery-codes/regenerate")
  @HttpCode(200)
  @UseGuards(ThrottlerGuard, PlatformAuthGuard)
  @SkipThrottle(SKIP_PASSWORD_THROTTLER)
  async regenerate(
    @Req() request: PlatformRequest,
    @Body() body: RegenerateRecoveryCodesDto,
  ): Promise<{ recoveryCodes: string[] }> {
    const result = await regenerateRecoveryCodes(
      actorContext.getOrThrow(),
      { password: body.password, totpCode: body.totpCode },
      new Date(),
    );
    if (!result.ok) throw new UnauthorizedException(INVALID_CREDENTIALS);
    return { recoveryCodes: result.value.codes };
  }

  /**
   * The challenge at every subsequent sign-in.
   *
   * A wrong code is `401` with the same sentence as a wrong password, not a refusal code: at this
   * point the caller has proved nothing that entitles them to be told which half failed.
   */
  @Post("totp/verify")
  @HttpCode(200)
  @UseGuards(ThrottlerGuard, PendingPlatformGuard)
  async verify(
    @Req() request: PendingPlatformRequest,
    @Body() body: TotpCodeDto,
  ): Promise<{ accessToken: string; fullName: string }> {
    const passed = await verifySecondFactor(request.pendingOperator.userId, body.totpCode, new Date());
    if (!passed) throw new UnauthorizedException(INVALID_CREDENTIALS);

    return {
      accessToken: await issuePlatformToken(request.pendingOperator.userId, "full"),
      fullName: request.pendingOperator.fullName,
    };
  }

  /** Who the operator is, and which seat they hold — the console reads it to decide what to show. */
  @Get("me")
  @UseGuards(PlatformAuthGuard)
  async me(
    @Req() request: PlatformRequest,
  ): Promise<{
    userId: string;
    fullName: string;
    platformRole: string;
    recoveryCodesRemaining: number;
    via: "recovery" | null;
  }> {
    // The console nags below LOW_REMAINING_THRESHOLD, so the count travels with identity rather
    // than on a route of its own — a banner that needs a second request is a banner that flickers.
    //
    // `via` travels here too, rather than being remembered in the client, so a reload still knows
    // this session came from a recovery code and still insists on the replacement.
    return {
      userId: request.platformAdmin.userId,
      fullName: request.platformAdmin.fullName,
      platformRole: request.platformAdmin.platformRole,
      recoveryCodesRemaining: await countRecoveryCodes(request.platformAdmin.userId),
      via: request.platformAdmin.via ?? null,
    };
  }
}
