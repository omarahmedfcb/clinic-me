import {
  CallHandler,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  NestInterceptor,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Observable } from "rxjs";
import type { AuthenticatedRequest } from "./auth.guard.ts";
import { ALLOWED_WHILE_PASSWORD_EXPIRED } from "./password-change.guard.ts";
import { prisma } from "../prisma/client.ts";
import { refusal } from "./refusals.ts";

/**
 * **A forced password change is enforced, not asked for** — PR 10.
 *
 * While `users.must_change_password` is set, every authenticated route refuses except the one that
 * clears it. "Forced at next login" is a sentence a screen can honour and a caller with `curl`
 * cannot, so it lives on the server.
 *
 * **An interceptor rather than a guard, and that is the whole point.** Nest runs global guards
 * *before* route-level ones, so a global guard would run before `AuthGuard` had put any claims on
 * the request, read `undefined`, and let everything through. Interceptors run after every guard, so
 * this one sees a request that has been authenticated — the same reason `ActorContextInterceptor`
 * can bind an actor. Registered once in `AppModule`, because "every route except the change" is a
 * claim about all of them and fifteen `@UseGuards` lists are fifteen places to forget the sixteenth.
 *
 * Read from the database rather than from a token claim: an admin can set this flag on somebody who
 * is signed in right now, and a claim minted before that would say `false` until it expired.
 */
@Injectable()
export class PasswordChangeInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const exempt = this.reflector.getAllAndOverride<boolean>(ALLOWED_WHILE_PASSWORD_EXPIRED, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (exempt === true) return next.handle();

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    // Unauthenticated routes — login, refresh — have nobody to check and are not this rule's business.
    const claims = request.authClaims as AuthenticatedRequest["authClaims"] | undefined;
    if (claims === undefined) return next.handle();

    const user = await prisma.user.findUnique({
      where: { id: claims.sub },
      select: { mustChangePassword: true },
    });
    if (user?.mustChangePassword === true) {
      throw new ForbiddenException(refusal("PASSWORD_CHANGE_REQUIRED", {}));
    }

    return next.handle();
  }
}
