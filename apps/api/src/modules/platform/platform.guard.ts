// The wall — pilot-readiness 0a. Only an active platform admin passes, and only with a platform
// token. Re-checked on every request, because a flag revoked between requests must take effect now.

import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from "@nestjs/common";
import type { Request } from "express";
import { prisma } from "../../prisma/client.ts";
import { AccessTokenExpiredError } from "../auth/jwt.ts";
import { verifyPlatformToken } from "./platform-token.ts";
import { operatorTotpRequired } from "./totp-policy.ts";

export interface PlatformRequest extends Request {
  platformAdmin: {
    userId: string;
    fullName: string;
    platformRole: string;
    /** "recovery" when a recovery code opened this session rather than the authenticator. */
    via?: "recovery";
  };
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

    let claims;
    try {
      claims = await verifyPlatformToken(header.slice("Bearer ".length).trim());
    } catch (err) {
      throw new UnauthorizedException(
        err instanceof AccessTokenExpiredError ? "Platform token has expired." : "Platform token is invalid.",
      );
    }

    // A token that has passed the password and not the second factor opens nothing here. Checked in
    // the guard rather than route by route, so a route added later is refused by default.
    if (claims.stage !== "full") throw new UnauthorizedException("Platform token is invalid.");

    const user = await prisma.user.findFirst({
      where: { id: claims.sub, isPlatformAdmin: true, status: "ACTIVE" },
      select: { id: true, fullName: true, platformRole: true, totpConfirmedAt: true },
    });
    // The same answer for "not an operator", "suspended" and "no such user": which of the three it
    // is, is not something the holder of a rejected token should learn.
    if (user === null) throw new UnauthorizedException("Platform token is invalid.");

    // Re-read, like the flag above: an authenticator reset between requests must take effect now,
    // and a `full` token whose account no longer has a second factor is not one.
    //
    // Skipped entirely when `OPERATOR_TOTP=off`, which `assertOperatorTotpAllowed` makes impossible
    // in production — so this cannot become a way to hold a session without a second factor on a
    // live deployment.
    if (operatorTotpRequired() && user.totpConfirmedAt === null) {
      throw new UnauthorizedException("Platform token is invalid.");
    }

    request.platformAdmin = {
      userId: user.id,
      fullName: user.fullName,
      // A CHECK guarantees an operator has one; the fallback exists so a read never widens a role.
      platformRole: user.platformRole ?? "SUPPORT",
      // Carried through from the token: a session a recovery code opened has not proved possession
      // of the authenticator, and only that session may replace it.
      ...(claims.via === undefined ? {} : { via: claims.via }),
    };
    return true;
  }
}
