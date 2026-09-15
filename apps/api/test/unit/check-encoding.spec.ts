/**
 * The pre-push encoding check — the two residues a shell has actually left in this repo.
 *
 * **What it catches:** `U+FFFD`, and runs of question marks inside a quoted string. The second is
 * the exact shape of 2026-09-13, when a `curl -d` with an Arabic name reached the API as
 * `"???? ??? ?????? ???????"` and was stored as the clinic owner's.
 *
 * **What it does not catch, asserted rather than assumed:** `فireEvent` — one ASCII letter replaced
 * by an Arabic one. The line still contains Arabic, no `?` and no `�`. A test below pins that, so
 * nobody reads a green hook as "the editor rule is optional".
 *
 * **And what it wrongly flags**, per the standing rule that a matching rule ships with its false
 * positives: a regular expression containing `\?{3}` inside a string, and a URL with a `???` in it.
 * Both are refused. Both are rare enough to be worth the trade, and `--no-verify` is the escape.
 */

type Finding = { file: string; line: string; reason: string };

const diff = (file: string, ...added: string[]): string =>
  [`diff --git a/${file} b/${file}`, `--- a/${file}`, `+++ b/${file}`, ...added.map((line) => `+${line}`)].join("\n");

describe("the pre-push encoding check", () => {
  let findEncodingDamage: (diff: string) => Finding[];

  beforeAll(async () => {
    // By relative path, so Jest resolves it through its own registry and transforms it. A
    // `file://` URL bypasses that and lands on the native ESM loader, which cannot load it here.
    ({ findEncodingDamage } = await import("../../../../scripts/check-encoding.mjs"));
  });

  describe("what it catches", () => {
    test("the replacement character, anywhere", () => {
      const found = findEncodingDamage(diff("apps/web/src/i18n/strings.ts", '  "a.b": "مر�ضاي",'));
      expect(found).toHaveLength(1);
      expect(found[0]?.reason).toContain("U+FFFD");
      expect(found[0]?.file).toBe("apps/web/src/i18n/strings.ts");
    });

    test("the 2026-09-13 incident, reproduced exactly", () => {
      // What the database actually held after `curl -d` mangled the owner's name.
      const found = findEncodingDamage(diff("seed.ts", '  fullName: "???? ??? ?????? ???????",'));
      expect(found).toHaveLength(1);
      expect(found[0]?.reason).toContain("question marks");
    });

    test("a short run is enough, so long as it is inside a string", () => {
      expect(findEncodingDamage(diff("a.ts", 'const name = "???";'))).toHaveLength(1);
    });
  });

  describe("what it leaves alone", () => {
    test("healthy Arabic", () => {
      expect(findEncodingDamage(diff("strings.ts", '  "credit.title": "رصيد المريض",'))).toEqual([]);
    });

    test("nullish coalescing, which is two question marks and not three", () => {
      expect(findEncodingDamage(diff("a.ts", "const value = input ?? fallback;"))).toEqual([]);
    });

    test("question marks outside a string", () => {
      expect(findEncodingDamage(diff("a.ts", "// what??? why???"))).toEqual([]);
    });

    test("removed lines, so the repair for an encoding mistake can itself be pushed", () => {
      const repair = [
        "diff --git a/seed.ts b/seed.ts",
        "--- a/seed.ts",
        "+++ b/seed.ts",
        '-  fullName: "???? ??? ??????",',
        '+  fullName: "أحمد عبد الرحمن",',
      ].join("\n");
      expect(findEncodingDamage(repair)).toEqual([]);
    });

    /** **The gap, pinned.** A green hook does not mean the editor rule may be skipped. */
    test("it cannot see a single letter swapped for an Arabic one", () => {
      expect(findEncodingDamage(diff("a.spec.tsx", "فireEvent.change(input, { target: {} });"))).toEqual([]);
    });
  });

  /**
   * The escape, found by the hook refusing the documentation that explains it — twice, one layer
   * apart. A file-wide exemption would have hidden which line was excused; this one is in the diff.
   */
  describe("a deliberate quotation can be marked", () => {
    test("on the line itself", () => {
      const marked = 'const example = "???" // encoding-check: allow';
      expect(findEncodingDamage(diff("a.ts", marked))).toEqual([]);
    });

    test("on the line above, so Markdown can use a comment that renders as nothing", () => {
      const found = findEncodingDamage(
        diff("docs/a.md", "<!-- encoding-check: allow -->", 'the API stored `"???? ???"` as a name'),
      );
      expect(found).toEqual([]);
    });

    test("but it does not leak to the line after that", () => {
      const found = findEncodingDamage(
        diff("docs/a.md", "<!-- encoding-check: allow -->", "an excused line", 'and then `"????"`'),
      );
      expect(found).toHaveLength(1);
    });
  });

  /**
   * Written out because a matching rule ships with what it wrongly merges, not only with what it
   * catches. Every case here is a legitimate `???` inside a string literal, and every one is
   * refused. The escape is `--no-verify` with the reason stated in the commit.
   */
  describe("what it wrongly flags", () => {
    test("a URL carrying three question marks", () => {
      expect(findEncodingDamage(diff("a.ts", 'const url = "https://example.test/a???b";'))).toHaveLength(1);
    });

    test("a deliberate placeholder or redaction", () => {
      expect(findEncodingDamage(diff("a.ts", 'const redacted = "card ending ????";'))).toHaveLength(1);
    });

    /**
     * **Not** a false positive, and worth pinning because it looks like one. A counted repetition
     * writes `\?{3}`, which is an escape and a quantifier — not three question marks — so the rule
     * that would most plausibly collide with real code does not.
     */
    test("a regular expression's counted repetition is left alone", () => {
      expect(findEncodingDamage(diff("a.ts", 'const pattern = new RegExp("\\\\?{3}");'))).toEqual([]);
    });
  });
});
