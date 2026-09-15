import { CLINICS } from "../../prisma/seed/blueprint.ts";

/**
 * **One person holds one role per clinic** — CLAUDE.md, ruled 2026-09-09, superseding 2026-09-06.
 *
 * The ruling is about the product's assumptions, not the schema: `memberships` still permits
 * several rows per person per clinic, because a doctor working in two clinics is the case the
 * unique index was dropped for. What is withdrawn is the seed manufacturing a person who owns a
 * clinic *and* works its desk, which quietly decided that an owner practises.
 *
 * This guards it where the mistake would actually be made — the blueprint — rather than in the
 * console line that described it. The console line was wrong for the whole of PR 7i: the seed had
 * already stopped creating the dual membership, and the summary went on announcing "one person,
 * two roles in ONE clinic" over a list with a single role in it. A caption cannot be trusted to
 * notice that the data beneath it changed; an assertion can.
 *
 * The positive half is not decoration. "No person holds two roles in one clinic" is satisfied by a
 * blueprint with no staff at all, and by one where every clinic is empty — so the shape being
 * asserted is pinned down first.
 */

describe("the seeded clinics give each person one role", () => {
  test("there are clinics, with staff, covering more than one role", () => {
    // Guards against the vacuity: every assertion below passes trivially on an empty blueprint.
    expect(CLINICS.length).toBeGreaterThan(1);
    for (const clinic of CLINICS) {
      expect(clinic.staff.length).toBeGreaterThan(1);
      expect(new Set(clinic.staff.map((member) => member.role)).size).toBeGreaterThan(1);
    }
  });

  test("no phone number appears twice within one clinic", () => {
    for (const clinic of CLINICS) {
      const phones = clinic.staff.map((member) => member.phoneE164);
      // Reported as the pair so a failure names the person and the clinic rather than a count.
      expect({ clinic: clinic.slug, duplicates: phones.filter((p, i) => phones.indexOf(p) !== i) })
        .toEqual({ clinic: clinic.slug, duplicates: [] });
    }
  });

  test("one person still works in two clinics, which is the case the schema keeps", () => {
    // The withdrawn membership and this one are different shapes, and only the first was withdrawn.
    // If this ever goes to zero the clinic switcher has nothing to exercise it.
    const byPhone = new Map<string, string[]>();
    for (const clinic of CLINICS) {
      for (const member of clinic.staff) {
        byPhone.set(member.phoneE164, [...(byPhone.get(member.phoneE164) ?? []), clinic.slug]);
      }
    }
    const acrossClinics = [...byPhone.values()].filter((slugs) => slugs.length > 1);
    expect(acrossClinics.length).toBeGreaterThan(0);
    // ...and they are genuinely different clinics, not the same one counted twice.
    for (const slugs of acrossClinics) expect(new Set(slugs).size).toBe(slugs.length);
  });
});
