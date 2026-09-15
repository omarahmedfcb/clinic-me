/**
 * The compile-time half of the tenant-scoping extension (tenant-scoping.extension.ts).
 *
 * Every model's `id` is a UUIDv7 with no `@default` in schema.prisma (SCHEMA-DECISIONS.md D6), and
 * every tenant-scoped model's `tenantId` comes from the validated request context, never from the
 * caller (CLAUDE.md). Both are therefore *required* in Prisma's generated create input, and both
 * are supplied by the extension at runtime -- so a correct call site looks, to the type checker,
 * like it is missing two required fields.
 *
 * That mismatch used to be silenced with `as never` at ~45 call sites. `as never` does not narrow
 * anything: it discards the entire create input type, so every other field went unchecked too. A
 * column could be renamed in schema.prisma and `npm run typecheck` would still pass, because no
 * write path was being checked against the schema at all.
 *
 * `injected()` closes exactly the two-field gap and nothing else. The argument is the real create
 * input minus `id` and `tenantId`; every remaining field is checked normally, so a renamed or
 * retyped column now fails the build.
 *
 * ```ts
 * await tx.patient.create({
 *   data: injected({ fullNameAr: "…", phoneE164: "+20…", relationshipToContact: "SELF", status: "ACTIVE" }),
 * });
 * ```
 *
 * `T` is inferred from the surrounding call -- Prisma's `data` parameter supplies it -- so call
 * sites do not name the input type. That is deliberate: an explicitly written type argument is a
 * second source of truth that can drift from the delegate it is passed to, and there would be one
 * per call site to keep correct. Pass one explicitly (`injected<Prisma.PatientCreateManyInput>(…)`)
 * only where inference genuinely has nothing to work from.
 *
 * `injected.spec.ts` asserts, at compile time, that this really does still reject a bad
 * field -- if inference ever degrades to `any`, that file fails rather than going quiet.
 */

/**
 * `id` is optional rather than omitted because callers legitimately supply one: seed and fixture
 * code generates ids up front so it can wire foreign keys before the rows exist. When absent, the
 * extension fills it in. It is typed `string` because every `@id` in schema.prisma is
 * `String @db.Uuid` (D6) -- there is no non-string id in this schema to preserve.
 */
export type Injectable<T> = Omit<T, "id" | "tenantId"> & { id?: string };

export function injected<T>(data: Injectable<T>): T {
  // The one unavoidable assertion, confined to this function: `data` is genuinely missing `id`
  // and/or `tenantId` at this point, and the extension adds them before the query is issued.
  return data as T;
}

/**
 * The same bridge for a model whose `TENANT_POLICY` is **not** `"scoped"`
 * (src/prisma/tenant-scoped-models.ts) -- today `AuditLog` and `MessageTemplate`, both `"nullable"`.
 * Recorded in SCHEMA-DECISIONS.md D16: the helper follows the registry, and reaching for
 * `injected()` on one of these is the mistake this exists to prevent.
 *
 * For those two the extension injects `id` and nothing else: a null `tenantId` is a meaningful,
 * deliberate value there (a platform-wide template, an audit row that outlived its tenant), so the
 * extension refuses to guess one and the caller must set it. `injected()` is therefore the wrong
 * helper for them -- it omits `tenantId` from the input, which would leave writing the column
 * impossible and quietly produce a NULL-tenant row. `injectedIdOnly()` keeps `tenantId` in the
 * type, exactly as the schema declares it.
 */
export type IdOnlyInjectable<T> = Omit<T, "id"> & { id?: string };

export function injectedIdOnly<T>(data: IdOnlyInjectable<T>): T {
  return data as T;
}
