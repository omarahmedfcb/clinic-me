import { CAPABILITIES, permissionLevel, type Capability } from "../../src/common/permissions.ts";

/**
 * ARCHITECTURE.md §12 rule 2 gives the AI agent "its own permission set -- strictly narrower than
 * a receptionist's", and specifies nothing beyond that sentence. PHASE-2.md §6 adds the
 * `AI_AGENT` enum value in Phase 2 because extending a Postgres enum is cheap against an empty
 * memberships table and awkward against a full one. The permission set itself is Phase 7 work.
 *
 * The gap between those two facts is the hazard this test exists for. An enum value with a
 * plausible-looking permission row is indistinguishable from one somebody thought about, and
 * nothing runs as AI_AGENT until the tool registry exists -- so any capability granted here today
 * would be a guess that reads as a decision, sitting unreviewed for several phases.
 *
 * So the column is empty and this asserts it. The failure mode is deliberate: the first person to
 * grant AI_AGENT a capability has to delete an assertion whose comment explains why they should
 * not do it casually. That is the Phase 7 conversation, triggered at the moment it becomes real
 * rather than remembered from a document.
 *
 * Delete this file when §12's permission set is genuinely decided -- and replace it with a test
 * that pins whatever was decided, not with nothing.
 */
describe("AI_AGENT holds no capability", () => {
  it.each(CAPABILITIES)("%s is NONE for AI_AGENT", (capability: Capability) => {
    expect(permissionLevel("AI_AGENT", capability)).toBe("none");
  });

  /**
   * The check above passes trivially if `CAPABILITIES` is ever emptied or if the role is dropped
   * from the matrix, so the shape is asserted too: twenty capabilities, and a receptionist who
   * genuinely holds some of them. Without this, "AI_AGENT has nothing" and "the matrix has
   * nothing" produce the same green run.
   */
  it("is compared against a matrix that is actually populated", () => {
    // 26 as of 2026-09-06: appointments.completeVisit joined when PHASE-3.md Q13 was revisited,
    // patients.browse when the patient list was ruled into Phase 4, patients.transfer when the
    // owner was separated from desk work, and patients.read / appointments.read when the two
    // "write" capabilities were found to be deciding seventeen reads between them.
    expect(CAPABILITIES).toHaveLength(28);
    expect(permissionLevel("RECEPTIONIST", "appointments.write")).toBe("full");
  });

  /**
   * §12's wording is "strictly narrower than a receptionist's", and that is a property worth
   * stating as a rule rather than leaving as an arithmetic accident of the empty column -- it is
   * what a future grant must still satisfy. Today it holds because AI_AGENT holds nothing; the
   * assertion survives the day that stops being true.
   */
  it("is narrower than a receptionist at every capability", () => {
    for (const capability of CAPABILITIES) {
      const receptionist = permissionLevel("RECEPTIONIST", capability);
      const agent = permissionLevel("AI_AGENT", capability);
      if (receptionist === "none") expect(agent).toBe("none");
    }
  });
});
