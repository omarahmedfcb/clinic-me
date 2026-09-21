import { CAPABILITIES, permissionLevel, type Capability } from "../../src/common/permissions.ts";
import type { MembershipRole } from "../../src/generated/prisma/enums.ts";

/**
 * The replacement for `permissions-ai-agent-holds-nothing.spec.ts`, deleted on 2026-09-18.
 *
 * That file's own closing instruction was to replace it "with a test that pins whatever was decided,
 * not with nothing". This is that test. What was decided is `docs/WHATSAPP-BOT-CONTRACT.md` §3:
 * eight capabilities, held by `AI_AGENT` alone, each doing one thing.
 *
 * The hazard has changed shape rather than gone away. It used to be "a capability granted to a role
 * nobody holds is a capability nobody reviews"; now it is a role that runs software we do not
 * control, so the question is whether its column ever grows a ninth row quietly. Growing it means
 * editing the list below, which is the conversation the deleted file existed to force.
 */
const BOT_CAPABILITIES: Capability[] = [
  "bot.findPatientByPhone",
  "bot.createProvisionalPatient",
  "bot.listSlots",
  "bot.book",
  "bot.reschedule",
  "bot.cancel",
  "bot.readAppointmentStatus",
  "bot.recordConsent",
];

const HUMAN_ROLES: MembershipRole[] = ["OWNER", "ADMIN", "DOCTOR", "RECEPTIONIST"];

describe("the AI_AGENT capability set", () => {
  test("AI_AGENT holds exactly the eight bot capabilities, and nothing else", () => {
    const held = CAPABILITIES.filter((capability) => permissionLevel("AI_AGENT", capability) !== "none");
    expect([...held].sort()).toEqual([...BOT_CAPABILITIES].sort());
  });

  /**
   * Named one by one rather than as "every capability not in the list above", so the assertion says
   * what it protects. These are the rows the contract calls never readable by the bot.
   */
  test.each([
    "visits.readContent",
    "visits.readIndex",
    "prescriptions.readItems",
    "prescriptions.readExistence",
    "prescriptions.write",
    "payments.read",
    "payments.record",
    "payments.adjust",
    "reports.financial",
    "auditLog.read",
    "patients.browse",
    "patients.read",
    "patients.write",
    "patients.merge",
    "users.manage",
  ])("AI_AGENT holds no %s", (capability) => {
    expect(permissionLevel("AI_AGENT", capability as Capability)).toBe("none");
  });

  test("no human role holds a bot capability: one act, one path, one set of refusals", () => {
    for (const capability of BOT_CAPABILITIES) {
      for (const role of HUMAN_ROLES) {
        expect([capability, role, permissionLevel(role, capability)]).toEqual([capability, role, "none"]);
      }
    }
  });

  test("every bot capability in the matrix is one this file lists", () => {
    const declared = CAPABILITIES.filter((capability) => capability.startsWith("bot."));
    expect([...declared].sort()).toEqual([...BOT_CAPABILITIES].sort());
  });
});
