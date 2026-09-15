import { readFileSync } from "node:fs";
import path from "node:path";
import { CAPABILITIES, permissionLevel, type Capability } from "../../src/common/permissions.ts";
import { stripComments } from "../../scripts/route-capabilities.ts";

/**
 * Reception can neither pause nor resume a consultation — the guard the founder attached to Q34.
 *
 * Asserted at the gate rather than only over HTTP. `pauseConsultation` also refuses a caller who is
 * not the appointment's own doctor, and that second check makes an end-to-end test pass even when
 * the *capability* is wrong: a receptionist admitted by the guard is then refused by ownership, and
 * the response looks identical. Two layers is the right design and a poor test, so this reads the
 * decorator and the matrix directly, where the two are distinguishable.
 */

const API_ROOT = path.resolve(__dirname, "..", "..");
const CONTROLLER = path.join(API_ROOT, "src", "modules", "queue", "queue.controller.ts");

/** The capability on the route immediately following `@Patch("queue/:id/<action>")`. */
function capabilityOf(action: string): string {
  const source = stripComments(readFileSync(CONTROLLER, "utf8"));
  const match = new RegExp(
    `@Patch\\(\\s*"queue/:id/${action}"\\s*\\)\\s*@RequirePermission\\(\\s*"([^"]+)"`,
  ).exec(source.replace(/\s+/g, " "));
  return match?.[1] ?? "";
}

describe("pausing a consultation is the doctor's, at the gate", () => {
  test("the routes exist and name a capability, so the assertions below mean something", () => {
    // Without this, a renamed route yields an empty string that trivially satisfies "not held by
    // reception" — a green run that checked nothing, which is the failure this project keeps finding.
    for (const action of ["pause", "resume"]) {
      const capability = capabilityOf(action);
      expect(capability).not.toBe("");
      expect(CAPABILITIES).toContain(capability);
    }
  });

  test("reception holds neither route's capability", () => {
    for (const action of ["pause", "resume"]) {
      // `PermissionGuard` refuses before any handler runs, so this is the matrix deciding it rather
      // than a branch somebody could delete.
      expect(permissionLevel("RECEPTIONIST", capabilityOf(action) as Capability)).toBe("none");
    }
  });

  test("a doctor holds both, or the feature is unreachable by the only person who can use it", () => {
    for (const action of ["pause", "resume"]) {
      expect(permissionLevel("DOCTOR", capabilityOf(action) as Capability)).not.toBe("none");
    }
  });
});
