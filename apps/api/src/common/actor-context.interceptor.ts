import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from "@nestjs/common";
import { Observable } from "rxjs";
import type { AuthenticatedRequest } from "./auth.guard.ts";
import { actorContext } from "./actor-context.ts";

/**
 * Binds the current request's actor for the rest of the request. That is the whole job.
 *
 * This is what is left of AuditInterceptor after SCHEMA-DECISIONS.md D16. That class wrote to
 * audit_logs; the trigger in prisma/sql/07-audit-triggers.sql does that now, on every write,
 * whether or not a route was wired to an interceptor and whether or not a service remembered to
 * report what it did. What a trigger genuinely cannot do is know the client IP and User-Agent --
 * those are HTTP-layer concepts with no representation inside Postgres -- so the application still
 * has to supply them, the same way it supplies app.current_tenant_id for RLS. Supplying them is
 * now the entire remaining responsibility, and the class is named for it: an interceptor still
 * called AuditInterceptor that writes no audit rows would be a trap for the next reader.
 *
 * Reads are wrapped too, unlike the old interceptor, which skipped GET/HEAD because it had
 * nothing to write for them. Binding is cheap, and READ_SENSITIVE / BREAK_GLASS_ACCESS auditing
 * (AuditAction has both) will need an actor bound on a read path -- there is no AFTER SELECT
 * trigger, so that mechanism has to live up here regardless. Skipping reads now would only mean
 * putting the binding back later.
 */
@Injectable()
export class ActorContextInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();

    // AuthGuard populates authClaims and runs before any interceptor. A route with no guard --
    // /auth/login, /health -- has no actor to bind, and nothing it does is tenant-scoped, so
    // there is nothing for the audit trigger to refuse. Pass it straight through rather than
    // inventing an actor for it.
    // Two kinds of authenticated caller, and both have an actor. `authClaims` is a clinic member,
    // populated by AuthGuard; `platformAdmin` is the operator, populated by PlatformAuthGuard — who
    // holds no membership and therefore no claims, but whose every write is audited (0f).
    const platform = (request as { platformAdmin?: { userId: string } }).platformAdmin;
    // A third kind, added 2026-09-15: an operator who has passed the password and not yet the second
    // factor. They act on their own account only (enrol, confirm), and `users_audit` refuses a write
    // with no actor bound — so enrolment needs one exactly as much as any other write does.
    const pending = (request as { pendingOperator?: { userId: string } }).pendingOperator;
    const userId = request.authClaims?.sub ?? platform?.userId ?? pending?.userId;
    if (userId === undefined) {
      return next.handle();
    }

    const actor = {
      userId,
      ip: request.ip ?? "unknown",
      userAgent: request.headers["user-agent"] ?? "unknown",
    };

    // Constructed manually rather than as next.handle().pipe(...) so that the subscribe() call --
    // and therefore the handler's actual execution -- happens synchronously inside run()'s
    // callback. AsyncLocalStorage only reliably propagates into continuations begun from inside
    // run()'s own synchronous frame; composing an Observable and returning it for something else
    // to subscribe to later loses the binding before execution starts. This is the same lesson
    // with-tenant.ts records, and it was learned here first.
    return new Observable((subscriber) => {
      actorContext.run(actor, () => {
        subscriber.add(next.handle().subscribe(subscriber));
      });
    });
  }
}
