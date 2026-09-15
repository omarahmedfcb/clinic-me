import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * `apps/web/index.html` must not mention the opening `head` tag before the real one.
 *
 * ## Why this needs a test, and why it recurred
 *
 * `@vitejs/plugin-react` injects its Fast Refresh preamble by string-matching the **first**
 * occurrence of the opening head tag. A mention of that tag in prose — in a comment, above the
 * real one — makes it inject the preamble *inside the comment*, where it never executes. Every
 * component module the plugin transforms then throws "can't detect preamble", and **every route
 * renders blank**.
 *
 * The failure has three properties that made it survive two rounds of review:
 *
 *   1. **The dev server reports success.** It serves 200, the HTML is well-formed, and the only
 *      symptom is a client-side error in a log nobody reads.
 *   2. **The production build is unaffected**, because it has no Fast Refresh preamble at all. So
 *      "look at the preview build instead" appears to fix it, and the bug survives untouched —
 *      which is exactly what happened here.
 *   3. **A blank page looks like a missing route or a stale tab**, not like a build-tool bug.
 *
 * That combination is this project's recurring shape: a thing that appears to work. The guard is
 * cheap and the failure it prevents costs a review cycle each time.
 */

const INDEX_HTML = path.resolve(__dirname, "..", "..", "..", "web", "index.html");

describe("apps/web/index.html keeps the React Fast Refresh preamble executable", () => {
  const html = readFileSync(INDEX_HTML, "utf8");

  // Built rather than written literally, so this file does not trip its own rule.
  const OPENING_HEAD = `<${"head"}>`;

  it("finds the file", () => {
    // Guards the guard: a wrong path would make the assertion below pass by reading nothing.
    expect(html.length).toBeGreaterThan(100);
  });

  it("has exactly one opening head tag, and it is the real one", () => {
    const occurrences = html.split(OPENING_HEAD).length - 1;
    expect(occurrences).toBe(1);
  });

  it("does not mention the opening head tag inside any comment", () => {
    const comments = html.match(/<!--[\s\S]*?-->/g) ?? [];
    const offenders = comments
      .filter((comment) => comment.includes(OPENING_HEAD))
      .map((comment) => comment.slice(0, 80).replace(/\s+/g, " "));

    // A mention here puts the preamble inside the comment and blanks every route in dev.
    expect(offenders).toEqual([]);
  });
});
