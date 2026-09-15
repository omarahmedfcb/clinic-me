import { prisma } from "../../src/prisma/client.ts";
import { withTenant } from "../../src/prisma/with-tenant.ts";
import {
  actorFor,
  createTestTenant,
  createTestUser,
  deleteTestTenant,
  deleteTestUser,
} from "./fixtures.ts";

/**
 * RLS on `tenants` — SCHEMA-DECISIONS.md D22.
 *
 * D15 left this table out, reasoning "Tenant IS a tenant". That is a correct explanation of why
 * the scoping extension cannot filter it — there is no `tenant_id` column to filter on — but it
 * silently also answered a question nobody asked, and the answer was wrong: it does not follow
 * that a session already bound to tenant A may read tenant B's row.
 *
 * Until D22 it could. `tenant.findMany()` **inside `withTenant()`** returned every clinic in the
 * database. That is the specific danger this test exists for: the call sits inside the one
 * construct in this codebase that is supposed to make scoping automatic, and every other table
 * reached through it genuinely is safe. This one was the exception, and nothing said so.
 */
describe("tenants RLS (D22)", () => {
  let tenantA: string;
  let tenantB: string;
  let userId: string;

  beforeAll(async () => {
    tenantA = await createTestTenant();
    tenantB = await createTestTenant();
    userId = await createTestUser();
  });

  afterAll(async () => {
    await deleteTestTenant(tenantA);
    await deleteTestTenant(tenantB);
    await deleteTestUser(userId);
    await prisma.$disconnect();
  });

  test("a bound session sees only its own tenant, even through an unfiltered findMany", async () => {
    const visible = await withTenant(tenantA, actorFor(userId), (tx) =>
      tx.tenant.findMany({ select: { id: true } }),
    );

    // The assertion that matters is the count, not the membership: before D22 this returned every
    // row in the database, and an application taking [0] would have used a stranger's settings.
    expect(visible).toHaveLength(1);
    expect(visible[0]?.id).toBe(tenantA);
  });

  test("a bound session cannot read another tenant by id", async () => {
    const other = await withTenant(tenantA, actorFor(userId), (tx) =>
      tx.tenant.findUnique({ where: { id: tenantB } }),
    );
    // Null, not an error — indistinguishable from a tenant that never existed, which is the same
    // property the cross-tenant 404 convention rests on.
    expect(other).toBeNull();
  });

  test("a bound session cannot write another tenant's scheduling policy", async () => {
    await withTenant(tenantA, actorFor(userId), (tx) =>
      tx.tenant.updateMany({ where: { id: tenantB }, data: { slotGranularityMinutes: 1 } }),
    );

    const untouched = await prisma.tenant.findUnique({
      where: { id: tenantB },
      select: { slotGranularityMinutes: true },
    });
    expect(untouched?.slotGranularityMinutes).toBe(15);
  });

  /**
   * The policy is deliberately inverted relative to every other one in the schema: it permits an
   * unbound session rather than failing closed. Three operations are structurally unbound —
   * creating a tenant (there is nothing to bind before the row exists), the name-search backfill,
   * and the seed's re-run check. This asserts that trade explicitly, so that "tightening" the
   * policy to fail closed breaks a test that explains why it must not, rather than breaking the
   * seed on somebody's machine a week later.
   */
  test("an unbound session still sees every tenant, which is what seeding and backfills need", async () => {
    const all = await prisma.tenant.findMany({ select: { id: true } });
    const ids = all.map((t) => t.id);
    expect(ids).toContain(tenantA);
    expect(ids).toContain(tenantB);
  });

  /**
   * `withTenant()` binds four session variables inside one transaction and Postgres discards them
   * when it ends. If that ever stopped being true, a pooled connection would carry one request's
   * tenant into the next request that reused it — so the unbound read above must stay unbound
   * after a bound one on the same pool.
   */
  test("the binding does not leak to the next query on the same pool", async () => {
    await withTenant(tenantA, actorFor(userId), (tx) => tx.tenant.findMany({ select: { id: true } }));
    const afterwards = await prisma.tenant.findMany({ select: { id: true } });
    expect(afterwards.length).toBeGreaterThan(1);
  });
});
