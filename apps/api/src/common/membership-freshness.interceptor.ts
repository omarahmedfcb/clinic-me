// Capabilities drop on the next request, not at the next login — the founder's ruling, 2026-09-13.
// An access token is self-contained, so a suspended or re-roled holder keeps it until it expires.

import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  UnauthorizedException,
} from "@nestjs/common";
import type { Observable } from "rxjs";
import type { AuthenticatedRequest } from "./auth.guard.ts";
import { prisma } from "../prisma/client.ts";

interface ResolvedMembership {
  membershipId: string;
  tenantId: string;
  role: string;
}

/**
 * Re-reads the membership behind the token and refuses a claim that no longer matches it.
 *
 * ## Why an interceptor and not `AuthGuard`
 *
 * `AuthGuard` imports nothing from `src/prisma/`, and `CLAUDE.md` is explicit about what happens
 * when it does: `prisma/client.ts` reads `APP_DATABASE_URL` at module scope, so every unit spec that
 * imports the guard would acquire a hidden dependency on a running environment — green locally,
 * unable to load on CI. `PasswordChangeInterceptor` already does a per-request read of the same
 * shape, and this sits beside it.
 *
 * Interceptors run after guards, so `PermissionGuard` has already allowed the request on the stale
 * claim by the time this throws. That is harmless: the handler never runs, nothing is written, and
 * the caller gets the 401. The alternative — a database read inside the permission decision — is the
 * coupling the guard was written to avoid.
 *
 * ## Why `resolve_active_membership`
 *
 * It is the SECURITY DEFINER function `prisma/sql/04` added for exactly this: reading one membership
 * with no tenant bound, which is the situation before `TenantGuard` runs. It returns no row when the
 * membership is suspended **or** its clinic is, so both cases land here as 401 rather than as a
 * request that proceeds with capabilities nobody holds any more.
 */
@Injectable()
export class MembershipFreshnessInterceptor implements NestInterceptor {
  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const claims = request.authClaims as AuthenticatedRequest["authClaims"] | undefined;
    // Unauthenticated routes — login, refresh — have no claim to check.
    if (claims === undefined) return next.handle();

    const rows = await prisma.$queryRaw<ResolvedMembership[]>`
      SELECT membership_id AS "membershipId", tenant_id AS "tenantId", role AS "role"
      FROM resolve_active_membership(${claims.sub}::uuid, ${claims.membershipId}::uuid)
    `;

    const current = rows[0];
    if (current === undefined) {
      // Suspended membership, or a suspended clinic. "Log in again" is the honest next action, and
      // the login will then refuse them if the suspension is why.
      throw new UnauthorizedException("Session is no longer valid. Please log in again.");
    }
    if (current.role !== claims.role) {
      throw new UnauthorizedException("Session is no longer valid. Please log in again.");
    }

    return next.handle();
  }
}
