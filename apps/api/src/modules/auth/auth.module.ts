import { Module } from "@nestjs/common";
import { ThrottlerModule } from "@nestjs/throttler";
import { AUTH_THROTTLERS } from "./auth-throttle.ts";
import { AuthController } from "./auth.controller.ts";

/**
 * The auth endpoints and their rate limiting.
 *
 * ThrottlerModule is configured here rather than in AppModule so the two named throttlers -- and
 * the reasoning in auth-throttle.ts for why there are two -- stay next to the routes they protect.
 * Nothing else in the application is rate-limited yet; when something is, it should get its own
 * limits rather than inherit these, which are tuned for credential guessing.
 *
 * Note the store is in-memory (@nestjs/throttler's default), which makes this a single-instance
 * deployment until Redis backs it. Recorded in docs/DEPLOY.md §9, because a second API replica
 * would not error -- each process would keep its own counters and the limit would quietly stop
 * meaning what it says.
 */
@Module({
  imports: [ThrottlerModule.forRoot(AUTH_THROTTLERS)],
  controllers: [AuthController],
})
export class AuthModule {}
