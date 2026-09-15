import { randomUUID } from "node:crypto";
import { linkPatients, listRelations, unlinkPatients } from "../../src/modules/patients/patient-relations.ts";
import { prisma } from "../../src/prisma/client.ts";
import { injected } from "../../src/prisma/injected.ts";
import { withTenant } from "../../src/prisma/with-tenant.ts";
import { actorFor, seedClinic, teardownClinic, type ClinicFixture } from "./fixtures.ts";

/**
 * Kinship between patients — `PHASE-4.md` Q30.
 *
 * The assertion that carries this file is that a link written from one side is **readable from the
 * other**. "Bidirectional" is the whole requirement, and a one-directional link is the failure it
 * describes: the son's record shows his mother and the mother's record shows nobody, which reads as
 * a bug in the mother's record rather than as a missing second row.
 */
describe("patient kinship", () => {
  let fixture: ClinicFixture;
  let caller: { tenantId: string; actor: ReturnType<typeof actorFor> };

  const makePatient = async (fullNameAr: string, gender: string | null): Promise<string> => {
    const id = randomUUID();
    await withTenant(fixture.tenantId, actorFor(fixture.userId), async (tx) => {
      await tx.patient.create({
        data: injected({
          id,
          fullNameAr,
          phoneE164: `+2010${String(Date.now()).slice(-8)}${Math.floor(Math.random() * 9)}`,
          gender,
          relationshipToContact: "SELF",
          status: "ACTIVE",
        }),
      });
    });
    return id;
  };

  beforeAll(async () => {
    fixture = await seedClinic();
    caller = { tenantId: fixture.tenantId, actor: actorFor(fixture.userId) };
  });

  afterAll(async () => {
    await teardownClinic(fixture);
    await prisma.$disconnect();
  });

  test("a link written one way is readable from the other, with the reciprocal", async () => {
    const mother = await makePatient("منى", "FEMALE");
    const son = await makePatient("علي", "MALE");

    // Told once: Ali is Mona's son.
    expect(await linkPatients(caller, mother, son, "SON")).toEqual({ ok: true });

    const fromMother = await listRelations(caller, mother);
    expect(fromMother).toHaveLength(1);
    expect(fromMother[0]).toMatchObject({ relatedPatientId: son, relation: "SON" });

    // The half that matters: nobody entered this row, and it has to be right.
    const fromSon = await listRelations(caller, son);
    expect(fromSon).toHaveLength(1);
    expect(fromSon[0]).toMatchObject({ relatedPatientId: mother, relation: "MOTHER" });
  });

  test("an unrecorded sex yields RELATIVE rather than an invented father", async () => {
    // Legacy rows have no sex — D26 made it required only at intake. Guessing would be a fact
    // nobody entered, which is the falsification D26 refuses for backfilled birthdays.
    const parent = await makePatient("ولي الأمر", null);
    const child = await makePatient("طفل", "MALE");

    await linkPatients(caller, parent, child, "SON");

    const fromChild = await listRelations(caller, child);
    expect(fromChild[0]).toMatchObject({ relatedPatientId: parent, relation: "RELATIVE" });
  });

  test("unlinking removes both rows, because half a link is worse than none", async () => {
    const husband = await makePatient("زوج", "MALE");
    const wife = await makePatient("زوجة", "FEMALE");
    await linkPatients(caller, husband, wife, "WIFE");

    expect(await unlinkPatients(caller, husband, wife)).toEqual({ ok: true });
    expect(await listRelations(caller, husband)).toEqual([]);
    expect(await listRelations(caller, wife)).toEqual([]);
  });

  test("a second link between the same pair is refused", async () => {
    const a = await makePatient("أ", "MALE");
    const b = await makePatient("ب", "FEMALE");
    await linkPatients(caller, a, b, "WIFE");

    expect(await linkPatients(caller, a, b, "MOTHER")).toEqual({ ok: false, code: "ALREADY_LINKED" });
  });

  test("nobody is their own relative, and the database says so too", async () => {
    const alone = await makePatient("وحيد", "MALE");
    expect(await linkPatients(caller, alone, alone, "SON")).toEqual({ ok: false, code: "SAME_PATIENT" });

    // The service refuses first, so the CHECK is asserted directly — a service-layer refusal alone
    // would pass on a machine where the constraint was never applied.
    await expect(
      withTenant(fixture.tenantId, actorFor(fixture.userId), async (tx) =>
        tx.patientRelation.create({
          data: injected({
            id: randomUUID(),
            patientId: alone,
            relatedPatientId: alone,
            relation: "SON",
            createdByUserId: fixture.userId,
          }),
        }),
      ),
    ).rejects.toThrow(/patient_relations_not_self/);
  });
});
