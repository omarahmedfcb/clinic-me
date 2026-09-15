// The wall — pilot-readiness 0a. Only an active platform admin passes, and only with a platform
// token. Re-checked on every request, because a flag revoked between requests must take effect now.

import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from "@nestjs/common";
import type { Request } from "express";
import { prisma } from "../../prisma/client.ts";
import { AccessTokenExpiredError } from "../auth/jwt.ts";
import { verifyPlatformToken } from "./platform-token.ts";

export interface PlatformRequest extends Request {
  platformAdmin: { userId: string; fullName: string };
}

/**
 * **The operator is re-checked on every request, not trusted from the token.**
 *
 * `is_platform_admin` is a boolean on a global row that somebody can turn off, and a token lives ten
 * minutes. The same reasoning as `MembershipFreshnessInterceptor`, which re-resolves a membership on
 * every authenticated request so a suspension takes effect at once rather than at the next refresh —
 * and it matters more here, because this is the account with no clinic to contain it.
 *
 * The read is deliberately **not** wrapped in `withTenant`: this session binds no tenant, which is
 * what leaves every RLS policy false and the clinical tables empty to it. `users` is not
 * tenant-scoped, so it is readable without a binding; nothing else this guard touches is.
 */
@Injectable()
export class PlatformAuthGuard implements CanActivate {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<PlatformRequest>();

    const header = request.headers.authorization;
    if (!header?.startsWith("Bearer ")) {
      throw new UnauthorizedException("Missing platform token.");
    }

    let userId: string;
    try {
      userId = (await verifyPlatformToken(header.slice("Bearer ".length).trim())).sub;
    } catch (err) {
      throw new UnauthorizedException(
        err instanceof AccessTokenExpiredError ? "Platform token has expired." : "Platform token is invalid.",
      );
    }

    const user = await prisma.user.findFirst({
      where: { id: userId, isPlatformAdmin: true, status: "ACTIVE" },
      select: { id: true, fullName: true },
    });
    // The same answer for "not an operator", "suspended" and "no such user": which of the three it
    // is, is not something the holder of a rejected token should learn.
    if (user === null) throw new UnauthorizedException("Platform token is invalid.");

    request.platformAdmin = { userId: user.id, fullName: user.fullName };
    return true;
  }
}
