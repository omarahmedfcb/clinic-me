import { describe, expect, test, beforeEach } from "vitest";
import { forget, recall, recoverable, remember } from "./draft-store.ts";

/**
 * The crash guarantee, at the level that can be asserted without a browser to kill.
 *
 * Q5 states it modestly on purpose: everything older than about two seconds survives. What makes
 * that true is that every keystroke writes here, while the server save is debounced — so this file
 * asserts the mirror keeps text the server never received, and drops text the server has superseded.
 */

beforeEach(() => {
  window.localStorage.clear();
});

describe("the per-draft recovery copy", () => {
  test("text written before a kill is still there afterwards", () => {
    remember("visit-a", 3, { diagnosis: "التهاب الجيوب" }, new Date("2026-09-07T10:00:00Z"));

    // No cleanup ran. A reload reads whatever the last keystroke left.
    const stored = recall("visit-a");
    expect(stored?.text.diagnosis).toBe("التهاب الجيوب");
    expect(stored?.revision).toBe(3);
  });

  test("two open drafts do not overwrite each other — Q17", () => {
    // The failure this catches: a single storage slot. Both drafts would appear to save, and the
    // second would silently hold the first's text on recovery.
    remember("visit-a", 1, { diagnosis: "A-TEXT" }, new Date());
    remember("visit-b", 1, { diagnosis: "B-TEXT" }, new Date());

    expect(recall("visit-a")?.text.diagnosis).toBe("A-TEXT");
    expect(recall("visit-b")?.text.diagnosis).toBe("B-TEXT");
  });

  test("forgetting one leaves the other", () => {
    remember("visit-a", 1, { diagnosis: "A-TEXT" }, new Date());
    remember("visit-b", 1, { diagnosis: "B-TEXT" }, new Date());
    forget("visit-a");

    expect(recall("visit-a")).toBeNull();
    expect(recall("visit-b")?.text.diagnosis).toBe("B-TEXT");
  });
});

describe("what the screen shows on open", () => {
  test("local text typed against the current revision is recovered", () => {
    remember("visit-a", 4, { diagnosis: "NEVER-REACHED-SERVER" }, new Date());
    const result = recoverable(recall("visit-a"), 4, { diagnosis: "" });

    expect(result.recovered).toBe(true);
    expect(result.text.diagnosis).toBe("NEVER-REACHED-SERVER");
  });

  test("local text from an older revision is discarded, because the server moved on", () => {
    // Saving from a second device advanced the row. The local copy is behind, and restoring it
    // would silently undo the newer save -- the exact thing compare-and-set exists to prevent.
    remember("visit-a", 2, { diagnosis: "OLD-LOCAL" }, new Date());
    const result = recoverable(recall("visit-a"), 5, { diagnosis: "NEWER-SERVER" });

    expect(result.recovered).toBe(false);
    expect(result.text.diagnosis).toBe("NEWER-SERVER");
  });

  test("identical text is not announced as a recovery", () => {
    remember("visit-a", 4, { diagnosis: "SAME" }, new Date());
    const result = recoverable(recall("visit-a"), 4, { diagnosis: "SAME" });

    expect(result.recovered).toBe(false);
  });

  test("no local copy leaves the server's text untouched", () => {
    const result = recoverable(null, 4, { diagnosis: "SERVER" });
    expect(result).toEqual({ text: { diagnosis: "SERVER" }, recovered: false });
  });
});
