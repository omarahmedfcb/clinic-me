import { readFileSync } from "node:fs";
import path from "node:path";
import { stripComments } from "../../scripts/route-capabilities.ts";

/**
 * Both surfaces a doctor uses can reach the visit screen.
 *
 * The blocker found on review 2026-09-07: `VisitDraftScreen` shipped with a route in `AppShell` and
 * nothing that navigated to it, so the only way in was typing a URL. A rendering test proves one
 * screen at a time and would not have noticed the second surface was never wired; this asserts both,
 * and fails when a refactor drops one.
 *
 * Same shape as `route-capability-manifest.spec.ts`: enumerate from source, fail the build on a gap.
 */

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const WEB = path.join(REPO_ROOT, "apps", "web", "src", "features");

const SURFACES = [
  { file: path.join(WEB, "queue", "QueuePage.tsx"), what: "the queue row" },
  {
    file: path.join(WEB, "appointment-detail", "AppointmentDetailPanel.tsx"),
    what: "the appointment panel",
  },
];

describe("a doctor can reach the visit screen from a screen, not only from the URL bar", () => {
  test.each(SURFACES)("$what calls openVisit()", ({ file }) => {
    const source = stripComments(readFileSync(file, "utf8"));
    expect(source).toContain("openVisit(");
  });

  test.each(SURFACES)("$what decides visibility with the shared rule", ({ file }) => {
    // Not a hand-rolled permission check per screen. Two copies of "who may open this" is how the
    // queue and the panel come to disagree, and one of them is then wrong for a role nobody tested.
    const source = stripComments(readFileSync(file, "utf8"));
    expect(source).toMatch(/mayOpenVisit\(|canWriteVisits/);
  });

  test("starting a consultation navigates, rather than leaving the doctor to find the way", () => {
    // The specific complaint: pressing "start" moved the row and left the doctor on the board.
    const source = stripComments(readFileSync(SURFACES[0]!.file, "utf8"));
    expect(source).toMatch(/move === "start"[\s\S]{0,120}openVisit\(/);
  });
});
