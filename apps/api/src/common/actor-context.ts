import { AsyncLocalStorage } from "node:async_hooks";
import type { ActorContext } from "../prisma/with-tenant.ts";

/**
 * Carries the current request's actor -- who is making the change, from where, with what client --
 * across async boundaries, so a service can hand it to withTenant() without it being threaded
 * through every method signature between the controller and the transaction.
 *
 * Exactly parallel to tenant-context.ts, and for the same reason: both are per-request facts that
 * every write needs and no service should have to plumb by hand. The difference is what reads
 * them. tenantContext is read by the Prisma extension automatically; this one is not read
 * automatically by anything -- withTenant() takes the actor as an explicit parameter (D16), so
 * `actorContext.getOrThrow()` appears at the call site rather than disappearing into it. That is
 * deliberate: a reviewer looking at a withTenant() call can see which actor a write is attributed
 * to without knowing this module exists.
 *
 * Populated once per request by ActorContextInterceptor from the validated JWT claim and the HTTP
 * request itself -- never from a body, query string, or header the client controls, with the
 * single exception of User-Agent, which is a client-controlled header by definition and is
 * recorded as an observation, not trusted as a fact.
 */
const storage = new AsyncLocalStorage<ActorContext>();

export const actorContext = {
  /** Runs `fn` with `actor` bound for the duration of the call. */
  run<T>(actor: ActorContext, fn: () => T): T {
    return storage.run(actor, fn);
  },

  /** Returns the current actor, or `undefined` outside any `run()` scope. */
  tryGet(): ActorContext | undefined {
    return storage.getStore();
  },

  /**
   * Returns the current actor. Throws if none is bound.
   *
   * Failing loudly is the right behaviour and costs nothing: the audit trigger
   * (prisma/sql/07-audit-triggers.sql) would refuse the write a moment later anyway, and it can
   * only report the table and operation. This can name the missing binding while the JavaScript
   * stack still points at the caller. An unattended process -- the nightly no-show job, a seed
   * script -- must not reach for this: it has no request to have been bound by, and should pass
   * systemActor() from modules/audit/system-actor.ts explicitly instead.
   */
  getOrThrow(): ActorContext {
    const actor = storage.getStore();
    if (actor === undefined) {
      throw new Error(
        "actorContext.getOrThrow() called with no actor bound. A write ran outside " +
          "ActorContextInterceptor's request scope. If this is an unattended process, pass " +
          "systemActor() explicitly -- do not catch this and substitute a default.",
      );
    }
    return actor;
  },
};
