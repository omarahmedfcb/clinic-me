import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Carries the current request's tenantId across async boundaries so the tenant-scoping Prisma
 * extension can read it without it being threaded through every service method call.
 *
 * Populated once per request by TenantGuard (Layer 1, ARCHITECTURE.md §6) from the validated JWT
 * membership claim -- never from a request body, query string, or header. TenantGuard is Nest
 * request-pipeline work and is not part of this file; this module only provides the storage
 * primitive it will call into.
 */
const storage = new AsyncLocalStorage<string>();

export const tenantContext = {
  /** Runs `fn` with `tenantId` bound as the current tenant for the duration of the call. */
  run<T>(tenantId: string, fn: () => T): T {
    return storage.run(tenantId, fn);
  },

  /**
   * Binds `tenantId` for the rest of the current async execution -- unlike run(), with no
   * wrapping callback. This exists for TenantGuard: a Guard's canActivate() has no equivalent of
   * an Interceptor's `next.handle()` to wrap, so there is no callback to hand to run() that would
   * cover "the controller method and every service call it makes for the rest of this request."
   * enterWith() is the correct primitive for exactly that shape -- populate now, stays bound
   * going forward for this same async chain. withTenant() (with-tenant.ts) still uses run(), not
   * this: a database transaction has a natural start/end to wrap, and scoping the bind tightly to
   * it is strictly better than leaving it ambient for longer than necessary.
   */
  enterWith(tenantId: string): void {
    storage.enterWith(tenantId);
  },

  /** Returns the current tenantId, or `undefined` outside any `run()` scope. */
  tryGet(): string | undefined {
    return storage.getStore();
  },

  /**
   * Returns the current tenantId. Throws if called outside a `run()` scope -- that means a
   * tenant-scoped Prisma query executed without TenantGuard having populated the context first,
   * which is a request-wiring bug, not a valid multi-tenant state. Failing loudly here is
   * deliberate: silently proceeding would mean a query runs with no tenant filter at all.
   */
  getOrThrow(): string {
    const tenantId = storage.getStore();
    if (tenantId === undefined) {
      throw new Error(
        "tenantContext.getOrThrow() called with no tenant bound. A tenant-scoped Prisma query " +
          "ran outside TenantGuard's request scope -- fix the caller, do not catch this.",
      );
    }
    return tenantId;
  },
};
