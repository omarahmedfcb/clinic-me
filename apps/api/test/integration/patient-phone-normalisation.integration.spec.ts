import {
  createPatient,
  householdByPhone,
  searchPatients,
  type CallerContext,
} from "../../src/modules/patients/patients.service.ts";

import { actorFor, seedClinic, teardownClinic, type ClinicFixture } from "./fixtures.ts";

/**
 * One number, one household, however reception typed it.
 *
 * Patient phones were stored exactly as typed until 2026-09-16 — `patients.dto.ts` claimed
 * normalising was "the caller's job at the edge" and no caller did it. So `0100 123 4567` and
 * `+201001234567` were two different strings, `contacts` is unique on (tenant, phone), and one
 * family with one number became two households that no search could reconcile.
 *
 * This is also a Phase 6 prerequisite rather than hygiene: WhatsApp is sent to this column
 * literally, so a number that is not E.164 is a message that never arrives.
 */

const TYPED = "0100 123 4567";
const E164 = "+201001234567";

describe("patient phone normalisation", () => {
  let clinic: ClinicFixture;
  let ctx: CallerContext;

  beforeAll(async () => {
    clinic = await seedClinic();
    ctx = { tenantId: clinic.tenantId, actor: actorFor(clinic.userId) };
  }, 60_000);

  afterAll(async () => {
    await teardownClinic(clinic);
  }, 60_000);

  const intake = (fullNameAr: string, phoneE164: string) =>
    createPatient(ctx, {
      fullNameAr,
      phoneE164,
      dateOfBirth: new Date("1990-01-01"),
      gender: "FEMALE",
      nationality: "EG",
      relationshipToContact: "SELF",
    });

  test("the same number in two notations is ONE household, not two", async () => {
    const first = await intake("مريضة الأولى", TYPED);
    const second = await intake("مريضة الثانية", E164);

    // Before the change the typed string and the E.164 string were two contacts, so each intake
    // opened its own household and this returned one member, not both.
    const household = await householdByPhone(ctx, E164);
    const members = (household?.members ?? []).map((member) => member.id);

    expect(members).toEqual(expect.arrayContaining([first.id, second.id]));
  });

  test("both notations are stored as E.164", async () => {
    const household = await householdByPhone(ctx, TYPED);
    expect(household?.phoneE164).toBe(E164);
  });

  test("the household is found by the notation that was NOT stored", async () => {
    const viaTyped = await householdByPhone(ctx, TYPED);
    const viaE164 = await householdByPhone(ctx, E164);
    expect(viaTyped?.contactId).toBe(viaE164?.contactId);
  });

  test("search finds the patient by the other notation", async () => {
    const found = await searchPatients(ctx, TYPED);
    expect(found.map((row) => row.phoneE164)).toContain(E164);
  });

  test("a phone that cannot parse is refused, naming the field", async () => {
    // Storing a wrong number is worse than rejecting it: Phase 6 sends to this column literally.
    await expect(intake("مريضة برقم خاطئ", "not-a-phone")).rejects.toMatchObject({
      response: { code: "INVALID_FIELD", params: { field: "phoneE164" } },
    });
  });

  test("a secondary phone that cannot parse is refused, naming that field", async () => {
    await expect(
      createPatient(ctx, {
        fullNameAr: "مريضة برقم ثانٍ خاطئ",
        phoneE164: "+201009999999",
        secondaryPhone: "12",
        dateOfBirth: new Date("1990-01-01"),
        gender: "FEMALE",
        nationality: "EG",
        relationshipToContact: "SELF",
      }),
    ).rejects.toMatchObject({
      response: { code: "INVALID_FIELD", params: { field: "secondaryPhone" } },
    });
  });
});
