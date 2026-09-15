import { injected } from "./injected.ts";
import type { TransactionClient } from "./with-tenant.ts";

/**
 * The point of injected() is that it closes the `id`/`tenantId` gap *without* switching off type
 * checking on everything else -- which is precisely what the `as never` casts it replaced did.
 *
 * That property cannot be observed at runtime: injected() is an identity function, and a call site
 * that has silently stopped being checked behaves exactly like one that is. So the assertions that
 * matter here are the `@ts-expect-error` lines below, and they are checked by `npm run typecheck`,
 * not by Jest.
 *
 * `@ts-expect-error` is the right tool rather than a comment saying "this would not compile":
 * TypeScript reports an *unused* `@ts-expect-error` as an error of its own. So if inference ever
 * degrades -- `T` widening to `any`, someone loosening the delegate types, a future Prisma release
 * changing the shape of the create input -- these lines stop erroring, the directives go unused,
 * and the build fails. The guard cannot rot into silence, which is the failure mode a plain
 * comment would have.
 *
 * `tx` is `declare`d, never assigned: this file must not open a database connection, and every
 * check below is resolved by the type checker without any of these calls being executed.
 */
declare const tx: TransactionClient;

// Nothing in this function is ever called. It exists to be type-checked.
async function typeChecks(): Promise<void> {
  // --- accepted: id and tenantId omitted, everything else real -------------------------------
  await tx.patient.create({
    data: injected({
      fullNameAr: "محمد أحمد",
      phoneE164: "+201000000000",
      relationshipToContact: "SELF",
      status: "ACTIVE",
    }),
  });

  // --- accepted: an explicitly supplied id, as seed and fixture code does ---------------------
  await tx.patient.create({
    data: injected({
      id: "0199a0f0-0000-7000-8000-000000000000",
      fullNameAr: "محمد أحمد",
      phoneE164: "+201000000000",
      relationshipToContact: "SELF",
      status: "ACTIVE",
    }),
  });

  // --- rejected: a misspelled or renamed column ----------------------------------------------
  // This is the whole reason the helper exists. Under `as never` this compiled.
  await tx.patient.create({
    data: injected({
      // @ts-expect-error -- `fullNameArabic` is not a column on patients
      fullNameArabic: "محمد أحمد",
      phoneE164: "+201000000000",
      relationshipToContact: "SELF",
      status: "ACTIVE",
    }),
  });

  // --- rejected: the right column with the wrong type -----------------------------------------
  await tx.patient.create({
    data: injected({
      // @ts-expect-error -- full_name_ar is text, not a number
      fullNameAr: 42,
      phoneE164: "+201000000000",
      relationshipToContact: "SELF",
      status: "ACTIVE",
    }),
  });

  // --- rejected: a required column left out ---------------------------------------------------
  // @ts-expect-error -- phoneE164, relationshipToContact and status are all NOT NULL
  await tx.patient.create({ data: injected({ fullNameAr: "محمد أحمد" }) });

  // --- rejected: a value outside the enum -----------------------------------------------------
  await tx.patient.create({
    data: injected({
      fullNameAr: "محمد أحمد",
      phoneE164: "+201000000000",
      relationshipToContact: "SELF",
      // @ts-expect-error -- PatientStatus is ACTIVE | ARCHIVED | MERGED
      status: "NOT_A_STATUS",
    }),
  });

  // --- rejected: a caller-supplied tenantId ---------------------------------------------------
  // tenantId comes from the validated JWT via tenantContext and is never written by a caller
  // (CLAUDE.md). The extension throws on a mismatch at runtime; this rejects it at compile time.
  await tx.patient.create({
    data: injected({
      // @ts-expect-error -- tenantId is injected, never passed
      tenantId: "0199a0f0-0000-7000-8000-000000000001",
      fullNameAr: "محمد أحمد",
      phoneE164: "+201000000000",
      relationshipToContact: "SELF",
      status: "ACTIVE",
    }),
  });

  // --- rejected: a write to a Postgres GENERATED column ---------------------------------------
  // Patient.nameSearchAr is `@ignore`d in schema.prisma, so it is not in the create input at all
  // (D19). Payment.remainingMinor deliberately is not `@ignore`d -- it has to stay readable for
  // the "who owes us money" query (D7) -- so for that one the extension's runtime guard is the
  // only thing standing in the way. See tenant-scoping.extension.spec.ts.
  await tx.patient.create({
    data: injected({
      fullNameAr: "محمد أحمد",
      phoneE164: "+201000000000",
      relationshipToContact: "SELF",
      status: "ACTIVE",
      // @ts-expect-error -- name_search_ar is computed by Postgres from full_name_ar
      nameSearchAr: "محمد احمد",
    }),
  });

  // --- createMany is checked the same way -----------------------------------------------------
  await tx.patient.createMany({
    // @ts-expect-error -- `fullName` was renamed to `fullNameAr` by D19
    data: [injected({ fullName: "محمد أحمد", phoneE164: "+201000000000", relationshipToContact: "SELF", status: "ACTIVE" })],
  });
}

describe("injected", () => {
  test("returns the same object it was given -- it is a type-level helper, not a transform", () => {
    const data = { fullNameAr: "محمد أحمد" };
    expect(injected<{ id: string; tenantId: string; fullNameAr: string }>(data)).toBe(data);
  });

  test("the compile-time checks in this file are the real assertions", () => {
    // Referencing typeChecks keeps it from reading as dead code; calling it would need a database.
    expect(typeof typeChecks).toBe("function");
  });
});
