import { Module } from "@nestjs/common";
import { ThrottlerModule } from "@nestjs/throttler";
import { ALL_THROTTLERS } from "./throttlers.ts";

/**
 * The one place `ThrottlerModule.forRoot()` is called, wrapped so it can be imported anywhere.
 *
 * `ThrottlerModule` is `@Global()`, so two `forRoot()` calls do not compose — the last one wins and
 * every name the others defined silently stops existing (see `throttlers.ts`). A wrapper class is
 * deduplicated by Nest's module registry, so importing this from five modules registers the options
 * once while letting each module — and each integration spec that boots one module on its own —
 * stand up without knowing where throttling was configured.
 */
@Module({
  imports: [ThrottlerModule.forRoot(ALL_THROTTLERS)],
  exports: [ThrottlerModule],
})
export class ThrottlingModule {}
