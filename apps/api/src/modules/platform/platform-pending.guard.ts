// The narrow door between the password and the second factor. Opens two routes and nothing else.

import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from "@nestjs/common";
import type { Request } from "express";
import { prisma } from "../../prisma/client.ts";
import { verifyPlatformToken } from "./platform-token.ts";

export interface PendingPlatformRequest extends Request {
  pendingOperator: { userId: string; fullName: string; totpEnrolled: boolean };
}

/**
 * Accepts a `pending` platform token — the five-minute one minted when the password was right and
 * the second factor has not been answered.
 *
 * It also accepts a `full` one, so that re-enrolling after a reset does not require signing out.
 * What it never does is stand in for `PlatformAuthGuard`: nothing behind this guard reads a clinic,
 * a contract or an operator list. The two routes it covers are "give me a secret to enrol" and
 * "here is a code" — both about the account in the token and nothing else.
 */
@Injectable()
export class PendingPlatformGuard implements CanActivate {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<PendingPlatformRequest>();

    const header = request.headers.authorization;
    if (!header?.startsWith("Bearer ")) throw new UnauthorizedException("Missing platform token.");

    let userId: string;
    try {
      userId = (await verifyPlatformToken(header.slice("Bearer ".length).trim())).sub;
    } catch {
      throw new UnauthorizedException("Platform token is invalid.");
    }

    const user = await prisma.user.findFirst({
      where: { id: userId, isPlatformAdmin: true, status: "ACTIVE" },
      select: { id: true, fullName: true, totpConfirmedAt: true },
    });
    if (user === null) throw new UnauthorizedException("Platform token is invalid.");

    request.pendingOperator = {
      userId: user.id,
      fullName: user.fullName,
      totpEnrolled: user.totpConfirmedAt !== null,
    };
    return true;
  }
}
