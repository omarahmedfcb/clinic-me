import { prisma } from "./client.ts";
import { tenantContext } from "./tenant-context.ts";

/**
 * UUID-shaped string, any version/variant. Deliberately permissive on the version nibble --
 * tenantId/actor.userId values in this codebase are always UUIDv7 (D6), but this check only needs
 * to rule out "not a UUID at all". It is not a UUIDv7 validator.
 */
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The `tx` handed to a withTenant() callback. Exported so callers -- services, and the
 * compile-time checks in src/prisma/injected.spec.ts -- can name the type without reaching into
 * client.ts and evaluating it.
 */
export type TransactionClient = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

/**
 * Who is making this change. Required by withTenant(), never optional -- see the note on the
 * function itself.
 *
 * `ip` and `userAgent` are HTTP-layer facts a database trigger structurally cannot discover on
 * its own (SCHEMA-DECISIONS.md D16's comparison table), which is precisely why they are threaded
 * through here alongside the actor rather than left for the audit trigger to guess at.
 */
export interface ActorContext {
  userId: string;
  ip: string;
  userAgent: string;
}

/**
 * Rejects a value that is not a UUID before it is bound as a Postgres session variable.
 *
 * This is not SQL-injection defence -- set_config() below takes bind parameters, so a malformed
 * value could not escape its parameter slot even if it tried. It is fail-fast: every consumer of
 * these session variables reads them back with `NULLIF(current_setting(...), '')::uuid`, and that
 * cast throws on a non-empty value that is not a UUID. Left unchecked, a malformed tenantId would
 * surface as an opaque cast error from inside an unrelated RLS policy evaluation, on whichever
 * query happened to run first. Checked here, it names the offending parameter at the boundary.
 */
function assertUuidShape(value: string, label: string): void {
  if (!UUID_SHAPE.test(value)) {
    throw new Error(
      `withTenant: ${label} "${value}" is not a well-formed UUID. It is bound as a Postgres ` +
        "session variable that RLS policies and the audit trigger both read back with a ::uuid " +
        "cast, so a malformed value is refused here rather than left to throw from inside a " +
        "policy evaluation. This should be unreachable in practice: both tenantId and " +
        "actor.userId come from a validated JWT claim, never from user input.",
    );
  }
}

/**
 * The one sanctioned way to run a tenant-scoped Prisma operation (ARCHITECTURE.md §6, Layers 2
 * and 3 together) -- and, since D16, the one place that binds *who* is making the change
 * alongside *which tenant* it is for.
 *
 * `actor` is a required parameter, not an optional one. That is the same defense-in-depth split
 * as tenant scoping itself: a compile-time requirement (this signature) backed by an independent
 * runtime one (the audit trigger in prisma/sql/07-audit-triggers.sql, which raises if
 * `app.current_actor_id` is unbound). Neither is trusted to be the only thing standing between
 * the database and an unattributed write. There is deliberately no lesser variant of this
 * function that skips supplying an actor -- an unattended process (the nightly no-show job of
 * ARCHITECTURE.md §9, a seed script, a data migration) passes the seeded system user instead, via
 * systemActor() in ../modules/audit/system-actor.ts.
 *
 * Layer 2 (tenant-scoping.extension.ts) only knows about `tenantContext` -- it has no idea
 * Postgres RLS exists. Layer 3 (Postgres RLS, prisma/sql/01-constraints.sql) only knows about the
 * `app.current_tenant_id` session variable -- it has no idea the Prisma extension exists. Nothing
 * connects them automatically: a caller could bind one without the other, and either half missing
 * means a tenant-scoped query either gets rejected by RLS with an opaque error (Layer 3 bound,
 * Layer 2 not -- impossible via the extension, but very possible via a raw query) or runs with no
 * database-level enforcement at all (Layer 2 bound, Layer 3 not).
 *
 * `withTenant` closes that gap by construction: every binding happens inside the same
 * `$transaction`, from the same validated values, and there is no exported way to get one without
 * the others.
 */
/**
 * The platform operator's session: **an actor, and deliberately no tenant** — pilot-readiness 0a.
 *
 * `app.current_actor_id` is bound because the audit triggers refuse a write without one (D16), and
 * an operator's writes to `users` are exactly the ones somebody will want to look up later.
 * `app.current_tenant_id` is left unbound because the operator belongs to no clinic, which leaves
 * every RLS policy's `tenant_id = NULLIF(current_setting(...), '')` false: the clinical and
 * financial tables are not filtered for them, they are **empty**.
 *
 * Named here rather than open-coded at each call site so that "no tenant is bound" is a property of
 * the helper instead of something each caller has to remember not to do.
 */
export async function withPlatformActor<T>(
  actor: ActorContext,
  fn: (tx: TransactionClient) => Promise<T>,
): Promise<T> {
  assertUuidShape(actor.userId, "actor.userId");

  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`
      SELECT set_config('app.current_actor_id', ${actor.userId}, true),
             set_config('app.current_ip', ${actor.ip}, true),
             set_config('app.current_user_agent', ${actor.userAgent}, true)
    `;
    // No `tenantContext.run`: the scoping extension must stay unbound, so any attempt to touch a
    // tenant-scoped model from here fails loudly rather than reaching for a default.
    return fn(tx);
  });
}

export async function withTenant<T>(
  tenantId: string,
  actor: ActorContext,
  fn: (tx: TransactionClient) => Promise<T>,
): Promise<T> {
  assertUuidShape(tenantId, "tenantId");
  assertUuidShape(actor.userId, "actor.userId");

  return prisma.$transaction(async (tx) => {
    // set_config(name, value, is_local => true) rather than `SET LOCAL name = '...'`. The two are
    // exactly equivalent in effect -- same GUC, same transaction-local lifetime, both read back by
    // current_setting() -- but SET is a utility statement with no bind-parameter support, so it
    // can only be built by string interpolation. set_config is an ordinary function call, so
    // these are real bind parameters. That matters most for userAgent: it is a raw,
    // attacker-controlled HTTP header with no fixed shape to validate against, and this is the
    // one formulation where it never becomes part of SQL text at all.
    //
    // Transaction-local, per ARCHITECTURE.md §6's pooling caveat: all four are discarded the
    // moment the transaction ends, so a pooled connection cannot leak one request's context into
    // the next request that reuses it.
    await tx.$queryRaw`
      SELECT set_config('app.current_tenant_id', ${tenantId}, true),
             set_config('app.current_actor_id', ${actor.userId}, true),
             set_config('app.current_ip', ${actor.ip}, true),
             set_config('app.current_user_agent', ${actor.userAgent}, true)
    `;

    // The callback must be async and must await here, not just return the promise fn() produces.
    // AsyncLocalStorage only reliably tracks continuations that were awaited from inside the
    // run() callback's own execution -- returning an un-awaited PrismaPromise loses the bound
    // tenantId the instant run() itself returns, before the query actually executes. Verified by
    // smoke check: the first draft of this pattern in tenant-scoping.extension.ts's own tests hit
    // exactly this bug.
    return tenantContext.run(tenantId, async () => {
      return await fn(tx);
    });
  });
}
