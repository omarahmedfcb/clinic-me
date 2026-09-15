import { randomUUID } from "node:crypto";
import { prisma } from "../../src/prisma/client.ts";
import { injected } from "../../src/prisma/injected.ts";
import { withTenant } from "../../src/prisma/with-tenant.ts";
import { actorFor, createTestTenant, createTestUser, deleteTestTenant, deleteTestUser } from "./fixtures.ts";

/**
 * Ports the withTenant() smoke script run by hand across the last three sessions (id/tenantId
 * injection, mismatch rejection, remainingMinor rejection, nested-write rejection, cross-tenant
 * isolation, fresh-call re-binding) into the repo, against the dedicated clinic_os_test database,
 * connected as clinic_os_app via TEST_APP_DATABASE_URL (bound in test/integration/setup-env.ts).
 */
describe("withTenant end-to-end", () => {
  let tenantA: string;
  let tenantB: string;
  let userId: string;

  beforeAll(async () => {
    tenantA = await createTestTenant();
    tenantB = await createTestTenant();
    userId = await createTestUser();
  });

  afterAll(async () => {
    await withTenant(tenantA, actorFor(userId), async (tx) => tx.patient.deleteMany()).catch(() => undefined);
    await withTenant(tenantB, actorFor(userId), async (tx) => tx.patient.deleteMany()).catch(() => undefined);
    await deleteTestTenant(tenantA);
    await deleteTestTenant(tenantB);
    await deleteTestUser(userId);
    await prisma.$disconnect();
  });

  test("rejects a malformed tenantId before touching the database", async () => {
    await expect(
      withTenant("not-a-uuid", actorFor(userId), async (tx) => tx.patient.findMany()),
    ).rejects.toThrow("not a well-formed UUID");
  });

  test("auto-injects id and tenantId on create, with nothing but withTenant()", async () => {
    const created = await withTenant(tenantA, actorFor(userId), async (tx) =>
      tx.patient.create({
        data: injected({
          fullNameAr: "Patient A",
          phoneE164: `+2012${randomUUID().replace(/-/g, "").slice(0, 8)}`,
          relationshipToContact: "SELF",
          status: "ACTIVE",
        }),
      }),
    );
    expect(typeof created.id).toBe("string");
    expect(created.id.length).toBeGreaterThan(0);
    expect(created.tenantId).toBe(tenantA);
  });

  test("rejects an explicit tenantId that does not match the bound context", async () => {
    await expect(
      withTenant(tenantA, actorFor(userId), async (tx) =>
        tx.patient.create({
          data: injected({
            fullNameAr: "Sneaky",
            phoneE164: `+2013${randomUUID().replace(/-/g, "").slice(0, 8)}`,
            relationshipToContact: "SELF",
            status: "ACTIVE",
            // @ts-expect-error -- deliberate. injected() rejects a caller-supplied tenantId at
            // compile time (asserted in src/prisma/injected.spec.ts); this test is about the
            // independent runtime check in the extension, which is what still stands between the
            // database and a write that never went through injected() at all -- a raw payload, a
            // dynamically built object, a future code path nobody has written yet.
            tenantId: tenantB,
          }),
        }),
      ),
    ).rejects.toThrow("does not match");
  });

  test("rejects a write to a GENERATED column before it reaches Postgres", async () => {
    // `Payment.remainingMinor` was this test's subject until Phase 5 PR 5 removed the column: a
    // balance is a sum across payment rows now, which no generated column can express. The
    // extension's guard is unchanged and still has a subject -- `Patient.nameSearchAr` (D19) --
    // so the test points at that instead of being deleted with the column.
    await expect(
      withTenant(tenantA, actorFor(userId), async (tx) =>
        tx.patient.create({
          data: injected({
            fullNameAr: "Patient For Generated Column",
            phoneE164: `+2014${randomUUID().replace(/-/g, "").slice(0, 8)}`,
            relationshipToContact: "SELF",
            status: "ACTIVE",
            nameSearchAr: "written by hand",
          } as never),
        }),
      ),
    ).rejects.toThrow("GENERATED column");
  });

  test("rejects a nested create on a tenant-scoped relation immediately", async () => {
    await expect(
      withTenant(tenantA, actorFor(userId), async (tx) =>
        tx.patient.create({
          data: injected({
            fullNameAr: "Nested Patient",
            phoneE164: `+2015${randomUUID().replace(/-/g, "").slice(0, 8)}`,
            relationshipToContact: "SELF",
            status: "ACTIVE",
            // @ts-expect-error -- deliberate, for the same reason as the tenantId case above: a
            // nested relation write is not a valid create input, and this asserts the extension's
            // runtime guard rejects one anyway.
            visits: { create: [{ status: "DRAFT" }] },
          }),
        }),
      ),
    ).rejects.toThrow('nested "create" is not allowed');
  });

  test("isolates reads across tenants and re-binds correctly on a fresh call", async () => {
    const seenFromB = await withTenant(tenantB, actorFor(userId), async (tx) => tx.patient.findMany());
    expect(seenFromB).toHaveLength(0);

    const seenFromAOnce = await withTenant(tenantA, actorFor(userId), async (tx) => tx.patient.findMany());
    const countBefore = seenFromAOnce.length;
    expect(countBefore).toBeGreaterThan(0);

    // A brand new withTenant() call is a brand new transaction with no carried-over state --
    // this proves SET LOCAL's transaction scoping, not leftover connection state.
    const seenFromAAgain = await withTenant(tenantA, actorFor(userId), async (tx) => tx.patient.findMany());
    expect(seenFromAAgain).toHaveLength(countBefore);
  });
});
