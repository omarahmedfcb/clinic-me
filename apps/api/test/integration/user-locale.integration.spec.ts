import { randomUUID } from "node:crypto";
import type { LocaleCode } from "../../src/generated/prisma/client.ts";
import { prisma } from "../../src/prisma/client.ts";
import { injectedIdOnly } from "../../src/prisma/injected.ts";
import { createTestTenant, deleteTestTenant, deleteTestUser } from "./fixtures.ts";

/**
 * `users.locale` is the per-user interface-language override of SCHEMA-DECISIONS.md D20.
 *
 * The value domain is guarded twice, and the two layers catch different things.
 *
 * The **enum** (`LocaleCode`) makes `locale` `"ar" | "en"` in every consumer, so a wrong value is a
 * compile error and never reaches the database. That is what stops ordinary application code, and
 * it is why the invalid cases below are raw SQL: through the typed client they no longer compile,
 * which is the point.
 *
 * The **CHECK** catches what the type system does not see — raw queries, a future migration, a
 * `psql` session. It is also the narrower of the two: `ALTER TYPE ... ADD VALUE` widens the enum
 * without touching the CHECK, so adding a third language stays a deliberate two-step act.
 *
 * The nullability is the subtler of the two and the easier to break later. NULL means "no override,
 * follow the tenant", and it must stay distinguishable from an explicit `'ar'`: a `DEFAULT 'ar'`
 * added in some future migration would make every user who never opened the setting look like they
 * had chosen Arabic, and a clinic switching its default to English would find it changed nothing
 * for anybody. That failure is completely silent — every row still holds a valid locale.
 */

describe("users.locale (D20)", () => {
  const createdUserIds: string[] = [];

  async function createUser(locale: LocaleCode | null): Promise<string> {
    const id = randomUUID();
    await prisma.user.create({
      // Users are not tenant-scoped, so the extension supplies only the id.
      data: injectedIdOnly({
        id,
        phoneE164: `+2012${id.replace(/-/g, "").slice(0, 8)}`,
        passwordHash: "test-hash-not-real",
        fullName: "Locale Test User",
        status: "ACTIVE",
        locale,
      }),
    });
    createdUserIds.push(id);
    return id;
  }

  afterAll(async () => {
    for (const id of createdUserIds) await deleteTestUser(id);
  });

  test("accepts the two supported locales", async () => {
    for (const locale of ["ar", "en"] as const) {
      const id = await createUser(locale);
      const user = await prisma.user.findUniqueOrThrow({ where: { id }, select: { locale: true } });
      expect(user.locale).toBe(locale);
    }
  });

  test("defaults to NULL, meaning no override rather than a chosen Arabic", async () => {
    const id = randomUUID();
    await prisma.user.create({
      data: injectedIdOnly({
        id,
        phoneE164: `+2013${id.replace(/-/g, "").slice(0, 8)}`,
        passwordHash: "test-hash-not-real",
        fullName: "No Override User",
        status: "ACTIVE",
      }),
    });
    createdUserIds.push(id);

    const user = await prisma.user.findUniqueOrThrow({ where: { id }, select: { locale: true } });
    // Not "ar". A DEFAULT here would erase the difference between "never chose" and "chose Arabic",
    // and the D20 resolution chain depends on telling those apart.
    expect(user.locale).toBeNull();
  });

  test("the enum rejects an unsupported locale at compile time", () => {
    // The first layer, and not a runtime assertion at all. If `locale` ever widens back to `string`
    // the directive goes unused and the build fails -- the same mechanism as injected.spec.ts.
    const valid: LocaleCode = "ar";
    expect(valid).toBe("ar");

    // @ts-expect-error -- "AR" is not a LocaleCode. Neither is "en-GB", "arabic" or "".
    const invalid: LocaleCode = "AR";
    expect(invalid).toBe("AR");
  });

  test("the CHECK rejects an unsupported locale on a path the types do not see", async () => {
    // Raw SQL, because the enum makes this uncompilable through the client. "AR" is the realistic
    // one: case-mismatched, looks right in a config file, and would fall through the D20 resolution
    // chain to whatever the frontend does with an unrecognised locale.
    const tenantId = await createTestTenant();
    try {
      for (const invalid of ["AR", "arabic", "en-GB", "", "fr"]) {
        await expect(
          prisma.$executeRawUnsafe(
            `UPDATE tenants SET locale = '${invalid}'::locale_code WHERE id = '${tenantId}'::uuid`,
          ),
        ).rejects.toThrow();
      }
    } finally {
      await deleteTestTenant(tenantId);
    }
  });

  test("tenants.locale rejects the BCP-47 tag that used to live in it", async () => {
    // "ar-EG" is what the column actually held before D20 redefined it, and writing it is what
    // broke `npm run seed` when the CHECK first landed. The region belongs in the frontend Intl
    // mapping, not in a stored preference.
    const tenantId = await createTestTenant();
    try {
      await expect(
        prisma.$executeRawUnsafe(`UPDATE tenants SET locale = 'ar-EG'::locale_code WHERE id = '${tenantId}'::uuid`),
      ).rejects.toThrow();
    } finally {
      await deleteTestTenant(tenantId);
    }
  });
});
