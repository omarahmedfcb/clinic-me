import { prisma } from "../../src/prisma/client.ts";
import { injected } from "../../src/prisma/injected.ts";
import { withTenant } from "../../src/prisma/with-tenant.ts";
import { actorFor, createTestTenant, createTestUser, deleteTestTenant, deleteTestUser } from "./fixtures.ts";

/**
 * Every guard proven elsewhere in this session (AuthGuard, TenantGuard, PermissionGuard) can be
 * bypassed by a future bug: a route missing @UseGuards(), a controller that calls a service
 * before the guards run, a background job that never goes through HTTP at all. This spec proves
 * the layer underneath all of them still holds when that happens -- not "the guards work," but
 * "a service reached with no guard, no withTenant(), nothing at all still fails loudly rather
 * than running unscoped." That's the property that matters most: it's what's left standing after
 * every other layer has already failed.
 */
describe("tenant isolation invariants", () => {
  describe("a service method reached outside any tenant binding fails loudly", () => {
    test("a read on a tenant-scoped model throws, rather than running unscoped", async () => {
      // No withTenant(), no guard, no tenantContext.run()/enterWith() anywhere in this call --
      // this is prisma.patient.findMany() called exactly as a service with a missing withTenant()
      // wrapper would call it.
      await expect(prisma.patient.findMany()).rejects.toThrow("no tenant bound");
    });

    test("a write on a tenant-scoped model throws, rather than silently writing unscoped data", async () => {
      // The extension's tenantContext.getOrThrow() throws synchronously in JS, before the
      // extension builds a query at all -- nothing is ever dispatched to Postgres for this call
      // to reject partway through. The rejection itself is the complete proof nothing was
      // written; there is no separate row to go check afterward.
      await expect(
        prisma.patient.create({
          data: injected({
            fullNameAr: "Should Never Be Created",
            phoneE164: "+201000000099",
            relationshipToContact: "SELF",
            status: "ACTIVE",
          }),
        }),
      ).rejects.toThrow("no tenant bound");
    });
  });

  describe("a cross-tenant lookup returns nothing, never another tenant's data (the basis for 404-not-403)", () => {
    let tenantA: string;
    let tenantB: string;
    let userId: string;

    beforeAll(async () => {
      tenantA = await createTestTenant();
      tenantB = await createTestTenant();
      userId = await createTestUser();
    });

    afterAll(async () => {
      await withTenant(tenantA, actorFor(userId), async (tx) => tx.patient.deleteMany());
      await withTenant(tenantB, actorFor(userId), async (tx) => tx.patient.deleteMany());
      await deleteTestUser(userId);
      await deleteTestTenant(tenantA);
      await deleteTestTenant(tenantB);
      await prisma.$disconnect();
    });

    test("a findUnique-by-id for another tenant's record resolves to null, not an error and not the record", async () => {
      const patientInTenantB = await withTenant(tenantB, actorFor(userId), async (tx) =>
        tx.patient.create({
          data: injected({ fullNameAr: "Tenant B Patient", phoneE164: "+201000000088", relationshipToContact: "SELF", status: "ACTIVE" }),
        }),
      );

      const result = await withTenant(tenantA, actorFor(userId), async (tx) => tx.patient.findUnique({ where: { id: patientInTenantB.id } }));

      // null, not the record, and not a thrown error either -- this is exactly why the HTTP
      // layer must map "not found" to 404 (NotFoundException), never 403 (ForbiddenException):
      // there is no "found, but forbidden" state visible to the controller at all. A controller
      // that added a separate ownership check to return 403 here would have nothing to check
      // against -- the query already made the record indistinguishable from one that never
      // existed. That mapping (null -> NotFoundException) is a controller-layer convention, not
      // something a guard enforces; there is no in-scope endpoint yet to demonstrate it against
      // (Patients CRUD is explicitly out of Phase 1's scope, per PHASE-1.md) -- this proves the
      // data-layer guarantee the convention will rest on once one exists.
      expect(result).toBeNull();
    });
  });
});
