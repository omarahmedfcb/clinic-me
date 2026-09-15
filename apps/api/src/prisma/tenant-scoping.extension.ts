import { uuidv7 } from "uuidv7";
import type { Prisma, PrismaClient } from "../generated/prisma/client.ts";
import { tenantContext } from "./tenant-context.ts";
import { isTenantScoped } from "./tenant-scoped-models.ts";

/**
 * One Prisma Client Extension with four responsibilities, per SCHEMA-DECISIONS.md D6/D7 and
 * ARCHITECTURE.md §6 Layer 2:
 *
 *   1. Tenant scoping   -- inject `where.tenantId` (reads/updates/deletes) and `data.tenantId`
 *                          (creates) on every "scoped" model, from tenantContext, never from
 *                          caller-supplied args. If a caller-supplied tenantId doesn't match,
 *                          throw -- a mismatch is a bug, and silently overwriting it would hide
 *                          that bug instead of surfacing it.
 *   2. Id generation    -- every model's `id` is UUIDv7 with no `@default` in schema.prisma
 *                          (D6). Generate one on create when the caller didn't supply one.
 *   3. Generated-column guard -- Patient.nameSearchAr (D19) is a Postgres GENERATED column;
 *                          Postgres GENERATED columns, listed in GENERATED_COLUMNS_BY_MODEL
 *                          below. Prisma has no way to mark a field read-only, so this extension
 *                          rejects any write attempt at the application boundary, ahead of
 *                          Postgres's own "cannot insert into generated column" error.
 *
 *   4. Nested-write guard -- nested creates/updates on a relation (e.g. `patient.create({ data:
 *                          { visits: { create: {...} } } })`) do not re-enter `$allOperations`
 *                          for the nested model, so responsibilities 1-3 above never run for
 *                          them. Rather than let that surface later as an opaque Postgres RLS
 *                          error -- or worse, a silent unscoped write on a relation RLS doesn't
 *                          protect -- this extension detects the nested write shape and throws
 *                          immediately, naming the field and telling the caller to issue a
 *                          separate top-level call instead.
 *
 * Known limitations (not handled by this extension -- flagged, not silently absorbed):
 *   - Tenant assignment via relation `connect` (`data: { tenant: { connect: { id } } }`) is not
 *     recognised -- only the scalar `data.tenantId` form is. This matches how services are
 *     expected to write tenant-scoped creates (tenantId is always already known as a plain
 *     string from tenantContext, never something to "connect" via a nested relation object).
 *   - Plain `connect` / `disconnect` / `set` on a relation are deliberately NOT blocked by
 *     responsibility 4 -- they link to an already-existing row rather than writing new data, so
 *     the risk is different (referencing a row the caller was not authorised to see, not
 *     fabricating unscoped data) and out of scope here. `connect: { id: someOtherTenantsRowId }`
 *     is not currently rejected.
 */

type Row = Record<string, unknown>;

const CREATE_OPERATIONS = new Set(["create", "createMany", "createManyAndReturn"]);

const WHERE_TARGETED_OPERATIONS = new Set([
  "findFirst",
  "findFirstOrThrow",
  "findUnique",
  "findUniqueOrThrow",
  "findMany",
  "update",
  "updateMany",
  "updateManyAndReturn",
  "delete",
  "deleteMany",
  "count",
  "aggregate",
  "groupBy",
]);

export interface GeneratedColumn {
  /** Prisma Client field name -- what an attempted write actually carries. */
  field: string;
  /** Postgres column name, so the error names something greppable in prisma/sql/. */
  column: string;
  /** The generating expression and the decision that records it. */
  computedFrom: string;
}

/**
 * Every Postgres `GENERATED ALWAYS ... STORED` column, by model. This is a map rather than the
 * single hardcoded Payment check it started as because Patient.nameSearchAr became a second one
 * (D19) and had no guard at all -- a per-column `if` does not make it obvious that a new generated
 * column needs registering here, and a list does.
 *
 * **Add a row here whenever a `GENERATED` column is added in prisma/sql/.**
 * `test/integration/generated-columns-conformance.integration.spec.ts` enforces that: it asks
 * Postgres which columns are actually `GENERATED ALWAYS` and fails unless this map names exactly
 * those, so a new one cannot be added without registering it. Prisma's schema has no concept of a
 * generated column, so the database is the only source of truth available to check against.
 *
 * `Patient.nameSearchAr` is `@ignore`d in schema.prisma, so it is absent from the generated client
 * and a write is already a compile error. This map is the second layer, for paths the type checker
 * does not see -- raw data, `createMany` over a mapped array, a future `as` cast.
 *
 * **`Payment.remainingMinor` left this map on 2026-09-10 with the column** (Phase 5 PR 5). The
 * concept moved rather than disappeared: a balance is now a sum across payment rows, computed by
 * the `visit_charge_balances` view, which is what D7 as amended permits. One entry remains, and the
 * conformance test is what will notice if a third generated column appears without registering.
 */
export const GENERATED_COLUMNS_BY_MODEL = new Map<Prisma.ModelName, readonly GeneratedColumn[]>([
  [
    "Patient",
    [
      {
        field: "nameSearchAr",
        column: "name_search_ar",
        computedFrom: "normalize_arabic_name(full_name_ar) (SCHEMA-DECISIONS.md D19)",
      },
    ],
  ],
]);

function assertNoGeneratedColumnWrite(model: Prisma.ModelName, data: Row | Row[] | undefined): void {
  const generated = GENERATED_COLUMNS_BY_MODEL.get(model);
  if (!data || generated === undefined) return;
  for (const row of Array.isArray(data) ? data : [data]) {
    for (const { field, column, computedFrom } of generated) {
      if (field in row) {
        throw new Error(
          `${model}.${field} maps to ${column}, a Postgres GENERATED column computed from ` +
            `${computedFrom}. It is written by the database and can never be written from ` +
            "application code.",
        );
      }
    }
  }
}

/**
 * "Model.field" pairs whose column type is Json (schema.prisma) -- excluded from the nested-write
 * scan below, or a legitimate value like `settings: { create: "2026-01-01" }` would be misread as
 * a relation write and rejected. Keep this in sync with every `Json`/`Json?` field in the schema.
 */
const JSON_SCALAR_FIELDS = new Set([
  "Tenant.settings",
  "Membership.permissionsOverride",
  "Patient.emergencyContact",
  "Visit.vitals",
  "VisitRevision.changedFields",
  "VisitRevision.previousValues",
  "AuditLog.previousState",
  "AuditLog.newState",
  "Consent.evidence",
  "MessageTemplate.variables",
]);

const NESTED_WRITE_ACTIONS = new Set([
  "create",
  "createMany",
  "connectOrCreate",
  "update",
  "updateMany",
  "upsert",
  "delete",
  "deleteMany",
]);

function assertNoNestedRelationWrite(model: Prisma.ModelName, data: Row | Row[] | undefined): void {
  if (!data) return;
  for (const row of Array.isArray(data) ? data : [data]) {
    for (const [field, value] of Object.entries(row)) {
      if (JSON_SCALAR_FIELDS.has(`${model}.${field}`)) continue;
      if (value === null || typeof value !== "object" || Array.isArray(value) || value instanceof Date) continue;
      const offendingAction = Object.keys(value as Row).find((key) => NESTED_WRITE_ACTIONS.has(key));
      if (offendingAction) {
        throw new Error(
          `${model}.${field}: nested "${offendingAction}" is not allowed inside a top-level write. ` +
            "Nested relation writes bypass this extension's tenant-scoping, id generation, and " +
            "remainingMinor guards entirely -- Postgres RLS will then reject the write with an " +
            `opaque error, or silently succeed unscoped if the nested model isn't RLS-protected. ` +
            `Issue a separate top-level ${field} call instead.`,
        );
      }
    }
  }
}

function assertTenantMatches(existing: unknown, expected: string, where: string): void {
  if (existing !== undefined && existing !== expected) {
    throw new Error(
      `${where}: tenantId "${String(existing)}" was set explicitly and does not match the ` +
        `current request's tenant "${expected}". A tenantId should never be supplied by the ` +
        "caller -- this is a bug, not a valid multi-tenant operation.",
    );
  }
}

function withGeneratedId(row: Row): Row {
  return row.id === undefined || row.id === null ? { ...row, id: uuidv7() } : row;
}

function withInjectedTenantId(row: Row, tenantId: string, where: string): Row {
  assertTenantMatches(row.tenantId, tenantId, where);
  return { ...row, tenantId };
}

// Prisma's generated type for a query spanning $allModels/$allOperations is a distributive
// conditional over every (model, operation) pair; TypeScript cannot statically prove that the
// `query` callback destructured for one specific invocation matches the loosely-typed `args` we
// build below, even though it always does at runtime -- the args shape we pass back out is the
// same object Prisma handed us, just mutated. AnyQuery is a narrow, deliberate escape hatch at
// exactly that boundary, not a general license for `any` elsewhere in this file.
type AnyQuery = (args: unknown) => Promise<unknown>;

export function withTenantScoping(client: PrismaClient) {
  return client.$extends({
    name: "tenant-scoping",
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          const runQuery = query as AnyQuery;
          if (model === undefined) return runQuery(args);

          const a = args as { where?: Row; data?: Row | Row[]; create?: Row; update?: Row };
          const scoped = isTenantScoped(model);

          if (CREATE_OPERATIONS.has(operation)) {
            if (a.data !== undefined) {
              const injectOne = (row: Row): Row => {
                assertNoGeneratedColumnWrite(model, row);
                assertNoNestedRelationWrite(model, row);
                let next = withGeneratedId(row);
                if (scoped) next = withInjectedTenantId(next, tenantContext.getOrThrow(), `${model}.${operation}`);
                return next;
              };
              a.data = Array.isArray(a.data) ? a.data.map(injectOne) : injectOne(a.data);
            }
            return runQuery(a);
          }

          if (operation === "upsert") {
            assertNoGeneratedColumnWrite(model, a.create);
            assertNoGeneratedColumnWrite(model, a.update);
            assertNoNestedRelationWrite(model, a.create);
            assertNoNestedRelationWrite(model, a.update);
            let create = a.create === undefined ? a.create : withGeneratedId(a.create);
            if (scoped) {
              const tenantId = tenantContext.getOrThrow();
              a.where = withInjectedTenantId(a.where ?? {}, tenantId, `${model}.upsert.where`);
              if (create !== undefined) create = withInjectedTenantId(create, tenantId, `${model}.upsert.create`);
              assertTenantMatches(a.update?.tenantId, tenantId, `${model}.upsert.update`);
            }
            a.create = create;
            return runQuery(a);
          }

          if (WHERE_TARGETED_OPERATIONS.has(operation)) {
            assertNoGeneratedColumnWrite(model, a.data);
            assertNoNestedRelationWrite(model, a.data);
            if (scoped) {
              a.where = withInjectedTenantId(a.where ?? {}, tenantContext.getOrThrow(), `${model}.${operation}.where`);
            }
            return runQuery(a);
          }

          return runQuery(args);
        },
      },
    },
  });
}
