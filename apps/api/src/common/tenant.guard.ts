import { CanActivate, ExecutionContext, Injectable, Logger } from "@nestjs/common";
import { tenantContext } from "../prisma/tenant-context.ts";
import type { AuthenticatedRequest } from "./auth.guard.ts";

/**
 * Populates tenantContext from the validated JWT claim -- and only that claim. A tenantId
 * anywhere else on the request (body, query string, header) is never read for this purpose; its
 * mere presence is logged as a security event and the request proceeds using the JWT's tenantId
 * regardless of what was supplied elsewhere. ARCHITECTURE.md §6, Layer 1.
 *
 * Must run after AuthGuard (reads request.authClaims, which AuthGuard sets).
 */
@Injectable()
export class TenantGuard implements CanActivate {
  private readonly logger = new Logger(TenantGuard.name);

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const { tenantId, sub: actorUserId } = request.authClaims;

    this.logSpoofAttempts(request, actorUserId);

    // enterWith(), not run(): a Guard's canActivate() has no equivalent of an Interceptor's
    // next.handle() to wrap -- there is no callback covering "the controller method and every
    // service call it makes for the rest of this request" to hand to run(). enterWith() binds
    // going forward from this point in the same async chain, which is exactly what's needed here.
    // See tenant-context.ts for the full reasoning and with-tenant.ts for the contrasting case
    // (a database transaction, which *does* have a natural start/end to scope tightly to).
    tenantContext.enterWith(tenantId);
    return true;
  }

  private logSpoofAttempts(request: AuthenticatedRequest, actorUserId: string): void {
    const body = request.body as Record<string, unknown> | undefined;
    const sources: Array<[string, unknown]> = [
      ["body", body?.["tenantId"]],
      ["query", request.query?.["tenantId"]],
      ["header", request.headers["x-tenant-id"]],
    ];
    for (const [source, value] of sources) {
      if (value !== undefined) {
        this.logger.warn(
          `SECURITY: tenantId supplied via ${source} by user ${actorUserId} on ` +
            `${request.method} ${request.originalUrl} -- ignored. tenantId is only ever taken ` +
            "from the validated JWT claim.",
        );
      }
    }
  }
}
