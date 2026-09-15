import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from "@nestjs/common";
import type { Request } from "express";
import {
  AccessTokenExpiredError,
  AccessTokenInvalidError,
  type AccessTokenClaims,
  verifyAccessToken,
} from "../modules/auth/jwt.ts";

export interface AuthenticatedRequest extends Request {
  authClaims: AccessTokenClaims;
}

function extractBearerToken(request: Request): string | undefined {
  const header = request.headers.authorization;
  if (!header?.startsWith("Bearer ")) return undefined;
  const token = header.slice("Bearer ".length).trim();
  return token.length > 0 ? token : undefined;
}

/**
 * Verifies the access token and attaches its claims to the request as `authClaims`. Must run
 * before TenantGuard and PermissionGuard, both of which read `request.authClaims` -- Nest applies
 * guards in the order they're registered, so this is an ordering requirement on whoever wires
 * @UseGuards()/APP_GUARD, not something this guard can enforce on its own.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = extractBearerToken(request);
    if (!token) {
      throw new UnauthorizedException("Missing access token.");
    }

    try {
      request.authClaims = await verifyAccessToken(token);
    } catch (err) {
      if (err instanceof AccessTokenExpiredError) {
        throw new UnauthorizedException("Access token has expired.");
      }
      if (err instanceof AccessTokenInvalidError) {
        throw new UnauthorizedException("Access token is invalid.");
      }
      throw err;
    }

    return true;
  }
}
