import { tenantContext } from "./tenant-context.ts";

describe("tenantContext", () => {
  test("tryGet() returns undefined outside any run() scope", () => {
    expect(tenantContext.tryGet()).toBeUndefined();
  });

  test("getOrThrow() throws outside any run() scope", () => {
    expect(() => tenantContext.getOrThrow()).toThrow("no tenant bound");
  });

  test("run() binds the tenantId for the duration of the callback", () => {
    const result = tenantContext.run("tenant-a", () => {
      expect(tenantContext.tryGet()).toBe("tenant-a");
      expect(tenantContext.getOrThrow()).toBe("tenant-a");
      return "callback-result";
    });
    expect(result).toBe("callback-result");
    expect(tenantContext.tryGet()).toBeUndefined();
  });

  test("nested run() calls restore the outer tenantId after the inner one returns", () => {
    tenantContext.run("outer", () => {
      expect(tenantContext.tryGet()).toBe("outer");
      tenantContext.run("inner", () => {
        expect(tenantContext.tryGet()).toBe("inner");
      });
      expect(tenantContext.tryGet()).toBe("outer");
    });
  });

  test("an async callback sees the bound tenantId across its own await points", async () => {
    await tenantContext.run("tenant-async", async () => {
      expect(tenantContext.tryGet()).toBe("tenant-async");
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(tenantContext.tryGet()).toBe("tenant-async");
    });
  });

  // NOTE: an earlier draft of this spec asserted that returning an un-awaited promise from
  // run() loses the bound context for a plain setTimeout-based continuation. That assertion was
  // wrong -- Node's AsyncLocalStorage correctly tracks a timer scheduled synchronously inside
  // run(), awaited or not, and the test failed against the real implementation. The actual bug
  // found while building with-tenant.ts was specific to how Prisma's PrismaPromise dispatches
  // (not reproducible with generic Promises/timers here), and is proven by
  // test/integration/with-tenant.integration.spec.ts, where withTenant() awaits fn() from inside
  // the run() callback for exactly this reason.

  test("enterWith() binds ambiently -- visible after the call returns, with no wrapping callback", () => {
    // Run inside an outer run() purely so this test cleans up after itself (run()'s own
    // restoration undoes whatever enterWith() did inside it once the outer callback returns) --
    // not because enterWith() itself needs a wrapping callback. That's the whole point of it:
    // TenantGuard has no such callback available and enterWith() doesn't need one.
    tenantContext.run("sentinel", () => {
      expect(tenantContext.tryGet()).toBe("sentinel");
      tenantContext.enterWith("entered-tenant");
      // Still bound *after* enterWith() returns, with no callback wrapping this line -- unlike
      // run(), which only binds for the duration of the function passed to it.
      expect(tenantContext.tryGet()).toBe("entered-tenant");
      expect(tenantContext.getOrThrow()).toBe("entered-tenant");
    });
    expect(tenantContext.tryGet()).toBeUndefined();
  });

  test("enterWith() stays bound across an async continuation with no wrapping callback", async () => {
    await tenantContext.run("sentinel", async () => {
      tenantContext.enterWith("entered-tenant-async");
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(tenantContext.tryGet()).toBe("entered-tenant-async");
    });
  });

  test("concurrent run() calls with different tenantIds do not leak into each other", async () => {
    const observed: Record<string, string | undefined> = {};

    async function work(tenantId: string, delayMs: number): Promise<void> {
      await tenantContext.run(tenantId, async () => {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        observed[tenantId] = tenantContext.tryGet();
      });
    }

    await Promise.all([work("tenant-x", 10), work("tenant-y", 0), work("tenant-z", 5)]);

    expect(observed["tenant-x"]).toBe("tenant-x");
    expect(observed["tenant-y"]).toBe("tenant-y");
    expect(observed["tenant-z"]).toBe("tenant-z");
  });
});
