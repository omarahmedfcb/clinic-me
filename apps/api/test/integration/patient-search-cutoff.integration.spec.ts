import { randomUUID } from "node:crypto";
import { latinSearchKey } from "../../src/modules/patients/domain/transliterate.ts";
import { searchPatients, type CallerContext } from "../../src/modules/patients/patients.service.ts";
import { prisma } from "../../src/prisma/client.ts";
import { injected } from "../../src/prisma/injected.ts";
import { withTenant } from "../../src/prisma/with-tenant.ts";
import { actorFor, seedClinic, teardownClinic, type ClinicFixture } from "./fixtures.ts";

/**
 * **احمد must not return محمد.**
 *
 * The two share the trigram `حمد`, so `pg_trgm` scores them as similar — and it is the most common
 * name pair in Egypt, so it fired on almost every search. Measured on real seeded data before any
 * change:
 *
 * ```
 * word_similarity(احمد, محمد) = 0.400    -- above D19's 0.3 threshold
 *      similarity(احمد, محمد) = 0.250    -- below it
 * ```
 *
 * The second line is the uncomfortable one: the noise is a direct consequence of the deliberate
 * Phase-1 switch to `word_similarity`, which was itself correct — a first name scored against a
 * three-part full name returns nothing under `similarity`.
 *
 * The measured separation, in both branches of the query:
 *
 * ```
 * Arabic  true 1.000   false 0.400 - 0.600
 * Latin   true 1.000   false 0.333   (mohamed …, and emad/imad — عماد reaches احمد through
 *                                     transliteration, a second false-positive family entirely)
 * ```
 *
 * True at 1.000, false at or below 0.600, **no overlap** — so the fix is a floor relative to the
 * best match, not a stricter threshold. `SIMILARITY_THRESHOLD` is deliberately unchanged: D19 fixed
 * it at 0.3 because a miss creates a duplicate, and duplicates split a medical history permanently.
 *
 * The last two tests are the ones that stop this being a threshold rise in disguise.
 */
describe("patient search suppresses weak matches only when a strong one exists", () => {
  let clinic: ClinicFixture;
  let caller: CallerContext;

  const add = async (fullNameAr: string): Promise<string> => {
    const id = randomUUID();
    await withTenant(clinic.tenantId, actorFor(clinic.userId), (tx) =>
      tx.patient.create({
        data: injected({
          id,
          fullNameAr,
          nameSearchLatin: latinSearchKey(fullNameAr, null),
          phoneE164: `+2010${id.replace(/-/g, "").slice(0, 7)}`,
          relationshipToContact: "SELF",
          status: "ACTIVE",
        }),
      }),
    );
    return id;
  };

  beforeAll(async () => {
    clinic = await seedClinic();
    caller = { tenantId: clinic.tenantId, actor: actorFor(clinic.userId) };
  });

  afterAll(async () => {
    await teardownClinic(clinic);
    await prisma.$disconnect();
  });

  test("احمد returns أحمد and not محمد", async () => {
    const ahmed = await add("أحمد سيد الديب");
    await add("محمد عوض");
    await add("محمد عبد الرحمن");
    await add("إيمان محمد عبد الحميد");

    const results = await searchPatients(caller, "احمد");
    const names = results.map((r) => r.fullNameAr);

    // Non-vacuity first: the real match must be there, or "no محمد" is satisfied by an empty list.
    expect(names).toContain("أحمد سيد الديب");
    expect(results.some((r) => r.id === ahmed)).toBe(true);

    const wrong = names.filter((n) => n.includes("محمد") && !n.includes("أحمد"));
    expect(wrong).toEqual([]);
  });

  test("عماد does not reach احمد through the Latin column either", async () => {
    // The second false-positive family, and the one that produced the reported result list.
    // latinSearchKey('احمد') is "ahmed ahmad"; عماد transliterates to "emad imad", which shares
    // "mad". A fix that only handled the Arabic branch would leave this in place.
    await add("أحمد فهمي");
    await add("فتحي عماد عبد الله");
    await add("عماد عمرو فهمي");

    const names = (await searchPatients(caller, "احمد")).map((r) => r.fullNameAr);
    expect(names.some((n) => n.includes("أحمد"))).toBe(true);
    expect(names.filter((n) => n.includes("عماد"))).toEqual([]);
  });

  test("محمد still finds محمد — the cutoff is not directional", async () => {
    const names = (await searchPatients(caller, "محمد")).map((r) => r.fullNameAr);
    expect(names.some((n) => n.includes("محمد"))).toBe(true);
  });

  /**
   * The two below are what make this a floor on results rather than a stricter match. Without them,
   * raising `SIMILARITY_THRESHOLD` to 0.7 would pass every test above — and would reintroduce
   * exactly the miss D19 exists to prevent.
   */
  test("a weak-but-only match is still returned, because nothing better exists", async () => {
    const fixture = await seedClinic();
    try {
      const only = { tenantId: fixture.tenantId, actor: actorFor(fixture.userId) };
      await withTenant(fixture.tenantId, actorFor(fixture.userId), (tx) =>
        tx.patient.create({
          data: injected({
            id: randomUUID(),
            fullNameAr: "محمد عوض",
            nameSearchLatin: latinSearchKey("محمد عوض", null),
            phoneE164: "+201099887766",
            relationshipToContact: "SELF",
            status: "ACTIVE",
          }),
        }),
      );

      // No أحمد in this tenant at all, so محمد at 0.400 is the best there is — and a receptionist
      // who finds nothing concludes the patient is unregistered and creates a duplicate (D19).
      const names = (await searchPatients(only, "احمد")).map((r) => r.fullNameAr);
      expect(names).toContain("محمد عوض");
    } finally {
      await teardownClinic(fixture);
    }
  });

  test("a phone match survives even though it scores zero on both name columns", async () => {
    // Phone hits are exempt from the floor. They score nothing on name similarity, so a relative
    // cutoff computed from names would silently delete the most reliable way to find somebody.
    const id = randomUUID();
    const phone = "+201555000111";
    await withTenant(clinic.tenantId, actorFor(clinic.userId), (tx) =>
      tx.patient.create({
        data: injected({
          id,
          fullNameAr: "سلمى ياسر منصور",
          nameSearchLatin: latinSearchKey("سلمى ياسر منصور", null),
          phoneE164: phone,
          relationshipToContact: "SELF",
          status: "ACTIVE",
        }),
      }),
    );

    const results = await searchPatients(caller, phone);
    expect(results.map((r) => r.id)).toContain(id);
  });
});
