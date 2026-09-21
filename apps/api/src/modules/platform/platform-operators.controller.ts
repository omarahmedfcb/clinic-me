import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UnprocessableEntityException,
  UseGuards,
} from "@nestjs/common";
import { IsIn, IsString, MaxLength, MinLength } from "class-validator";
import { actorContext } from "../../common/actor-context.ts";
import { refusal } from "../../common/refusals.ts";
import { recordPlatformAction } from "./platform-audit.ts";
import {
  createOperator,
  listOperators,
  resetOperatorTotp,
  setOperatorRole,
  OPERATOR_ROLES,
  type OperatorRefusal,
  type OperatorResult,
  type OperatorRole,
} from "./platform-operators.ts";
import { PlatformAuthGuard, type PlatformRequest } from "./platform.guard.ts";

export class NewOperatorDto {
  @IsString() @MinLength(2) @MaxLength(200) fullName!: string;
  @IsString() @MaxLength(40) phone!: string;
  @IsIn([...OPERATOR_ROLES]) operatorRole!: OperatorRole;
}

export class OperatorRoleDto {
  @IsIn([...OPERATOR_ROLES]) operatorRole!: OperatorRole;
}

export class ResetTotpDto {
  /** Required. Clearing somebody's second factor is a break-glass act and the trail must say why. */
  @IsString() @MinLength(3) @MaxLength(500) reason!: string;
}

/**
 * The vendor's own people — 2a.
 *
 * Every route is behind `PlatformAuthGuard`, which already demands a second factor; the OWNER-only
 * checks live in the service and read the database rather than the token, so a seat revoked a
 * minute ago refuses now.
 *
 * Audited into the **vendor's** trail (`recordPlatformAction`), never a clinic's: who we hire is not
 * a clinic's business, and `recordOperatorAction` would have to name a tenant to write at all.
 */
@Controller("platform/operators")
@UseGuards(PlatformAuthGuard)
export class PlatformOperatorsController {
  private unwrap<T>(result: OperatorResult<T>): T {
    if (result.ok) return result.value;
    const code: OperatorRefusal = result.code;
    const body = refusal(code, result.params);
    if (code === "NOT_FOUND") throw new NotFoundException(body);
    if (code === "NOT_OPERATOR_OWNER" || code === "SELF_ROLE_CHANGE" || code === "LAST_ADMIN") {
      throw new UnprocessableEntityException(body);
    }
    throw new BadRequestException(body);
  }

  @Get()
  async list(@Req() request: PlatformRequest) {
    void request;
    return { operators: await listOperators(actorContext.getOrThrow()) };
  }

  @Post()
  @HttpCode(201)
  async create(@Req() request: PlatformRequest, @Body() body: NewOperatorDto) {
    const actor = actorContext.getOrThrow();
    const created = this.unwrap(
      await createOperator(actor, {
        fullName: body.fullName,
        phone: body.phone,
        platformRole: body.operatorRole,
      }),
    );

    await recordPlatformAction(actor, {
      action: "CREATE",
      entityType: "users",
      entityId: created.userId,
      // Never the password, here or anywhere: an audit row outlives the reason it was written.
      detail: { what: "operator seated", role: body.operatorRole, by: request.platformAdmin.fullName },
    });

    return created;
  }

  @Post(":userId/role")
  @HttpCode(200)
  async changeRole(
    @Req() request: PlatformRequest,
    @Param("userId", ParseUUIDPipe) userId: string,
    @Body() body: OperatorRoleDto,
  ) {
    const actor = actorContext.getOrThrow();
    const changed = this.unwrap(await setOperatorRole(actor, userId, body.operatorRole));

    await recordPlatformAction(actor, {
      action: "UPDATE",
      entityType: "users",
      entityId: userId,
      detail: { what: "operator role", role: changed.platformRole, by: request.platformAdmin.fullName },
    });

    return changed;
  }

  /** The lost-phone path. OWNER only, and the operator must enrol again before anything works. */
  @Post(":userId/totp/reset")
  @HttpCode(200)
  async resetTotp(
    @Req() request: PlatformRequest,
    @Param("userId", ParseUUIDPipe) userId: string,
    @Body() body: ResetTotpDto,
  ) {
    const actor = actorContext.getOrThrow();
    const reset = this.unwrap(await resetOperatorTotp(actor, userId));

    // The reason is required rather than optional: this clears the only factor standing between a
    // password and a console that can reset a clinic administrator's password, and "why" is the
    // first question anybody reading the trail afterwards will ask.
    await recordPlatformAction(actor, {
      action: "BREAK_GLASS_ACCESS",
      entityType: "users",
      entityId: userId,
      detail: {
        what: "second factor and recovery codes cleared",
        who: reset.fullName,
        by: request.platformAdmin.fullName,
        reason: body.reason,
      },
    });

    return reset;
  }
}
