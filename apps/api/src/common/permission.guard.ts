import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { permissionLevel } from "./permissions.ts";
import { PERMISSION_METADATA_KEY, type RequiredPermission } from "./require-permission.decorator.ts";
import type { AuthenticatedRequest } from "./auth.guard.ts";

/**
 * Enforces the §8 permission matrix (permissions.ts) against `@RequirePermission()`. A route with
 * no `@RequirePermission()` decorator has nothing to enforce and is allowed through -- absence of
 * the decorator is not a default-deny; it means this guard has no opinion, same as a route with
 * no guard applied at all.
 *
 * Must run after AuthGuard (reads request.authClaims.role, which AuthGuard sets).
 */
@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<RequiredPermission | undefined>(PERMISSION_METADATA_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();

    // Derived here, per request, from the role in the token -- never read from a claim. The matrix
    // is the single source of truth, so a change to it is live on the next request rather than
    // fifteen minutes later when a token happens to refresh.
    const granted = permissionLevel(request.authClaims.role, required.capability);

    // "full" satisfies a route asking for "own"; "own" does not satisfy one asking for "full".
    const satisfied = granted === "full" || (granted === "own" && required.level === "own");
    if (!satisfied) {
      throw new ForbiddenException(`Missing permission: ${required.capability} (${required.level})`);
    }

    return true;
  }
}
