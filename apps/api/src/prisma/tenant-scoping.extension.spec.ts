import type { Prisma, PrismaClient } from "../generated/prisma/client.ts";
import { tenantContext } from "./tenant-context.ts";
import { withTenantScoping } from "./tenant-scoping.extension.ts";

type AllOperationsHandler = (params: {
  model: Prisma.ModelName | undefined;
  operation: string;
  // biome-ignore lint: test-only, mirrors the extension's own AnyQuery escape hatch
  args: any;
  query: (args: unknown) => Promise<unknown>;
  // biome-ignore lint: test-only return type, avoids `unknown` casts at every call site below
}) => Promise<any>;

/**
 * Captures the extension's $allOperations handler without needing a real PrismaClient or
 * database connection -- a fake `$extends` implementation stands in for the real one, exactly as
 * "a mocked query callback" implies. This exercises assertNoGeneratedColumnWrite,
 * assertTenantMatches, and assertNoNestedRelationWrite only through withTenantScoping's public
 * surface; none of the three is exported individually.
 */
function captureAllOperations(): AllOperationsHandler {
  let captured: AllOperationsHandler | undefined;
  const fakeClient = {
    $extends(config: { query: { $allModels: { $allOperations: AllOperationsHandler } } }) {
      captured = config.query.$allModels.$allOperations;
      return {} as unknown;
    },
  };
  withTenantScoping(fakeClient as unknown as PrismaClient);
  if (!captured) throw new Error("test setup failed: $allOperations was not captured");
  return captured;
}

describe("tenant-scoping.extension", () => {
  let allOperations: AllOperationsHandler;

  beforeEach(() => {
    allOperations = captureAllOperations();
  });

  test("passes through operations with no model unchanged", async () => {
    const query = jest.fn().mockResolvedValue("raw-result");
    const result = await allOperations({ model: undefined, operation: "$queryRaw", args: ["x"], query });
    expect(result).toBe("raw-result");
    expect(query).toHaveBeenCalledWith(["x"]);
  });

  describe("id generation (D6)", () => {
    test("generates a UUID on create when id is absent", async () => {
      const query = jest.fn(async (args) => args);
      const result = await allOperations({ model: "Tenant", operation: "create", args: { data: { name: "X" } }, query });
      expect(typeof result.data.id).toBe("string");
      expect(result.data.id.length).toBeGreaterThan(0);
    });

    test("does not overwrite an explicitly supplied id", async () => {
      const query = jest.fn(async (args) => args);
      const result = await allOperations({
        model: "Tenant",
        operation: "create",
        args: { data: { id: "explicit-id", name: "X" } },
        query,
      });
      expect(result.data.id).toBe("explicit-id");
    });
  });

  describe("tenant-id injection (D12)", () => {
    test("injects tenantId from tenantContext on create for a scoped model", async () => {
      const query = jest.fn(async (args) => args);
      const result = await tenantContext.run("tenant-1", async () =>
        allOperations({ model: "Patient", operation: "create", args: { data: { fullNameAr: "X" } }, query }),
      );
      expect(result.data.tenantId).toBe("tenant-1");
    });

    test("throws if tenantContext is not bound for a scoped model", async () => {
      const query = jest.fn();
      await expect(
        allOperations({ model: "Patient", operation: "create", args: { data: { fullNameAr: "X" } }, query }),
      ).rejects.toThrow("no tenant bound");
      expect(query).not.toHaveBeenCalled();
    });

    test("does not inject tenantId for a non-scoped model, even inside a bound context", async () => {
      const query = jest.fn(async (args) => args);
      const result = await tenantContext.run("tenant-1", async () =>
        allOperations({ model: "Tenant", operation: "create", args: { data: { name: "X" } }, query }),
      );
      expect(result.data.tenantId).toBeUndefined();
    });

    test("throws if an explicit tenantId does not match the bound context", async () => {
      const query = jest.fn();
      await expect(
        tenantContext.run("tenant-1", async () =>
          allOperations({
            model: "Patient",
            operation: "create",
            args: { data: { fullNameAr: "X", tenantId: "tenant-2" } },
            query,
          }),
        ),
      ).rejects.toThrow("does not match");
      expect(query).not.toHaveBeenCalled();
    });

    test("injects where.tenantId on a read for a scoped model", async () => {
      const query = jest.fn(async (args) => args);
      const result = await tenantContext.run("tenant-1", async () =>
        allOperations({ model: "Patient", operation: "findMany", args: {}, query }),
      );
      expect(result.where.tenantId).toBe("tenant-1");
    });
  });

  describe("generated-column guard", () => {
    test("rejects a create that sets a generated column", async () => {
      const query = jest.fn();
      await expect(
        tenantContext.run("tenant-1", async () =>
          allOperations({ model: "Patient", operation: "create", args: { data: { nameSearchAr: "x" } }, query }),
        ),
      ).rejects.toThrow("GENERATED column");
      expect(query).not.toHaveBeenCalled();
    });

    test("rejects an update that sets a generated column", async () => {
      const query = jest.fn();
      await expect(
        tenantContext.run("tenant-1", async () =>
          allOperations({
            model: "Patient",
            operation: "update",
            args: { where: { id: "p1" }, data: { nameSearchAr: "x" } },
            query,
          }),
        ),
      ).rejects.toThrow("GENERATED column");
    });

    test("does not reject a create with no generated column", async () => {
      const query = jest.fn(async (args) => args);
      await expect(
        tenantContext.run("tenant-1", async () =>
          allOperations({ model: "Payment", operation: "create", args: { data: { patientId: "p1" } }, query }),
        ),
      ).resolves.toBeDefined();
    });

    // Patient.nameSearchAr is the second generated column (D19) and had no guard until
    // GENERATED_COLUMNS_BY_MODEL replaced the single hardcoded Payment check. It is `@ignore`d in
    // schema.prisma, so a typed call site cannot reach it -- these cover the paths that are not
    // typed: raw payloads, and anything that arrives as a plain object.
    test("rejects a create that sets Patient.nameSearchAr", async () => {
      const query = jest.fn();
      await expect(
        tenantContext.run("tenant-1", async () =>
          allOperations({
            model: "Patient",
            operation: "create",
            args: { data: { fullNameAr: "محمد أحمد", nameSearchAr: "محمد احمد" } },
            query,
          }),
        ),
      ).rejects.toThrow("name_search_ar");
      expect(query).not.toHaveBeenCalled();
    });

    test("rejects an update that sets Patient.nameSearchAr", async () => {
      const query = jest.fn();
      await expect(
        tenantContext.run("tenant-1", async () =>
          allOperations({
            model: "Patient",
            operation: "update",
            args: { where: { id: "p1" }, data: { nameSearchAr: "محمد احمد" } },
            query,
          }),
        ),
      ).rejects.toThrow("GENERATED column");
      expect(query).not.toHaveBeenCalled();
    });

    test("rejects nameSearchAr inside one row of a createMany batch", async () => {
      const query = jest.fn();
      await expect(
        tenantContext.run("tenant-1", async () =>
          allOperations({
            model: "Patient",
            operation: "createMany",
            args: { data: [{ fullNameAr: "أ" }, { fullNameAr: "ب", nameSearchAr: "ب" }] },
            query,
          }),
        ),
      ).rejects.toThrow("name_search_ar");
      expect(query).not.toHaveBeenCalled();
    });

    test("guards each model against its own columns only", async () => {
      // remainingMinor is not a Patient column, and nameSearchAr is not a Payment one -- a map
      // keyed by model has to stay keyed by model, not collapse into one list of field names.
      const query = jest.fn(async (args) => args);
      await expect(
        tenantContext.run("tenant-1", async () =>
          allOperations({ model: "Patient", operation: "create", args: { data: { remainingMinor: 1 } }, query }),
        ),
      ).resolves.toBeDefined();
      await expect(
        tenantContext.run("tenant-1", async () =>
          allOperations({ model: "Payment", operation: "create", args: { data: { nameSearchAr: "x" } }, query }),
        ),
      ).resolves.toBeDefined();
    });

    test("names the Postgres column and the generating expression, not just the field", async () => {
      const query = jest.fn();
      await expect(
        tenantContext.run("tenant-1", async () =>
          allOperations({ model: "Patient", operation: "create", args: { data: { nameSearchAr: "x" } }, query }),
        ),
      ).rejects.toThrow(/name_search_ar.*normalize_arabic_name\(full_name_ar\)/s);
    });
  });

  describe("nested-write guard", () => {
    test("rejects a nested create on a relation", async () => {
      const query = jest.fn();
      await expect(
        tenantContext.run("tenant-1", async () =>
          allOperations({
            model: "Patient",
            operation: "create",
            args: { data: { fullNameAr: "X", visits: { create: [{ status: "DRAFT" }] } } },
            query,
          }),
        ),
      ).rejects.toThrow('nested "create" is not allowed');
      expect(query).not.toHaveBeenCalled();
    });

    test("rejects a nested connectOrCreate on a relation", async () => {
      const query = jest.fn();
      await expect(
        tenantContext.run("tenant-1", async () =>
          allOperations({
            model: "Patient",
            operation: "update",
            args: {
              where: { id: "p1" },
              data: { visits: { connectOrCreate: { where: { id: "v1" }, create: { status: "DRAFT" } } } },
            },
            query,
          }),
        ),
      ).rejects.toThrow('nested "connectOrCreate" is not allowed');
    });

    test("does not reject a plain connect on a relation", async () => {
      const query = jest.fn(async (args) => args);
      await expect(
        tenantContext.run("tenant-1", async () =>
          allOperations({
            model: "Payment",
            operation: "create",
            args: { data: { collectedByUser: { connect: { id: "u1" } } } },
            query,
          }),
        ),
      ).resolves.toBeDefined();
    });

    test("does not mistake a Json scalar field for a relation write", async () => {
      const query = jest.fn(async (args) => args);
      const result = await allOperations({
        model: "Tenant",
        operation: "create",
        args: { data: { name: "X", settings: { create: "not-a-relation", value: 1 } } },
        query,
      });
      expect(result.data.settings).toEqual({ create: "not-a-relation", value: 1 });
    });
  });
});
