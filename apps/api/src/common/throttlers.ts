// Every named throttler in the application, registered once. Pilot-readiness 4b.

import { applyDecorators, Injectable, type ExecutionContext } from "@nestjs/common";
import {
  SkipThrottle,
  Throttle,
  ThrottlerGuard,
  type ThrottlerLimitDetail,
  type ThrottlerOptions,
} from "@nestjs/throttler";
import { AUTH_THROTTLERS } from "../modules/auth/auth-throttle.ts";
import { BOT_THROTTLERS } from "../modules/bot/bot-throttle.ts";
import { WRITE_THROTTLERS } from "./write-throttle.ts";

/**
 * **One registration, because `ThrottlerModule` is global.**
 *
 * `ThrottlerModule.forRoot()` is declared `@Global()`, so several calls to it do not compose: the
 * last module registered wins and every named throttler defined by the others stops existing. A
 * `@Throttle({ "intake-write": … })` naming a throttler nobody registered is not an error — it is a
 * no-op, and the route is unlimited while the decorator says otherwise.
 *
 * Found on 2026-09-19 while writing 4b's test: sixty-five patient creations in a row, every one
 * accepted, with the decorator in place. The lists stay beside the routes they protect; only the
 * registration moves here, and `throttler-registration.spec.ts` fails the build if a route names a
 * throttler this array does not carry.
 */
export const ALL_THROTTLERS: ThrottlerOptions[] = [
  ...AUTH_THROTTLERS,
  ...BOT_THROTTLERS,
  ...WRITE_THROTTLERS,
];

/**
 * `ThrottlerGuard`, plus the header every HTTP client actually looks for.
 *
 * A **named** throttler emits `Retry-After-<name>` — so a 429 from the intake limit arrived with
 * `retry-after-intake-write: 60` and no `Retry-After` at all. The bot contract (§7) tells an
 * external developer to "back off per `Retry-After`", and nothing was sending it. The named header
 * stays, because it says *which* bucket was exhausted; this adds the standard one beside it.
 */
@Injectable()
export class RetryAfterThrottlerGuard extends ThrottlerGuard {
  protected override async throwThrottlingException(
    context: ExecutionContext,
    detail: ThrottlerLimitDetail,
  ): Promise<void> {
    const response = context.switchToHttp().getResponse<{ header?: (name: string, value: string) => void }>();
    response.header?.("Retry-After", String(Math.ceil(detail.timeToBlockExpire)));
    await super.throwThrottlingException(context, detail);
  }
}

/** Every registered name, derived — the skip list below must never be a second hand-written one. */
export const THROTTLER_NAMES: string[] = ALL_THROTTLERS.map((throttler) => String(throttler.name));

/**
 * One route, one bucket: the named throttler applies and **every other one is skipped**.
 *
 * Two things make this necessary, and both are silent. Every registered throttler applies to every
 * guarded route, so a controller that added `ThrottlerGuard` for its own limit inherited the login
 * buckets too — patient intake was refused after five requests by the *password* limiter, whose key
 * is a user and whose window is fifteen minutes. And method-level `@SkipThrottle` **replaces** the
 * class-level metadata rather than merging with it, so `@SkipThrottle()` on the class plus
 * `{ mine: false }` on the route turns everything back on.
 *
 * The skip list is derived from `THROTTLER_NAMES`, so a throttler added tomorrow is skipped here
 * without anybody remembering to add it.
 */
export function ThrottleOnly(name: string, limit: number, ttl: number): MethodDecorator {
  const skips = Object.fromEntries(THROTTLER_NAMES.map((other) => [other, other !== name]));
  return applyDecorators(SkipThrottle(skips), Throttle({ [name]: { limit, ttl } }));
}

/**
 * Skips **every** registered throttler, which is not what `@SkipThrottle()` does.
 *
 * Bare `@SkipThrottle()` skips the throttler named `default`, and this application has none — so a
 * controller carrying it was still subject to every named bucket, login limits included. A GET on
 * the patient book started answering 429 after five requests, from the *password* limiter.
 */
export function SkipAllThrottlers(): ClassDecorator & MethodDecorator {
  return SkipThrottle(skipAllExcept());
}

/**
 * The skip map that leaves exactly `names` in force.
 *
 * Written as "everything except", derived from `THROTTLER_NAMES`, because the maps this replaced
 * were "these ones off" — hand-written lists of the *other* buckets, which stopped being complete
 * the moment a bucket was added elsewhere. The login routes were rate-limited by the patient-intake
 * limiter that way, and the failure looked like a change in the login limits.
 */
export function skipAllExcept(...names: string[]): Record<string, boolean> {
  return Object.fromEntries(THROTTLER_NAMES.map((name) => [name, !names.includes(name)]));
}
