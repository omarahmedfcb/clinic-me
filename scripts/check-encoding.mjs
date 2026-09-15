// Refuses a push carrying mangled text — the two signatures a shell has left in this repo's data.
// Reads a unified diff on stdin; exits 1 with the offending lines named.

/**
 * ## What this catches, and why these two patterns
 *
 * **U+FFFD, the replacement character.** Whatever produced it, a `�` in source or seed data means
 * bytes were decoded as something they were not. It has no legitimate use in this codebase.
 *
 * **A run of question marks inside a quoted string.** This is the exact shape of the 2026-09-13
 * incident: `curl -d '{"fullName":"أحمد عبد الرحمن الشناوي"}'` reached the API as
 * `"???? ??? ?????? ???????"` and was stored as the clinic owner's name. Every Arabic character
 * became `?`, so there is no Arabic left to find — the detectable residue is the question marks.
 *
 * ## What it does NOT catch, stated so nobody trusts it further than it goes
 *
 * The `فireEvent` case — one ASCII letter replaced by one Arabic letter — is invisible here. The
 * line still contains Arabic, contains no `?`, and contains no `�`. Catching that needs a spell of
 * the identifier, not an encoding check, and the rule that prevents it is still "use the editor".
 * This hook narrows the blast radius of breaking that rule; it does not make the rule optional.
 */

const REPLACEMENT = "�";

/** Three or more, because `??` appears in real code — `a ?? b`, and `???` does not. */
const QUESTION_RUN = /\?{3,}/;

/** A quoted string, single or double, on one line. Deliberately simple: this is a grep, not a parser. */
const QUOTED = /"[^"\n]*"|'[^'\n]*'/g;

/**
 * This file and its test, which necessarily contain the patterns they hunt for — found by running
 * the hook, which refused to let itself be pushed.
 *
 * Narrow on purpose, and named rather than pattern-matched. Damage hidden in these two would be in
 * a checker and its fixtures, visible to anyone reading them, and neither holds product data.
 */
const SELF = ["scripts/check-encoding.mjs", "test/unit/check-encoding.spec.ts"];

/**
 * A deliberate quotation of the damage — in a document explaining the rule, or a fixture.
 *
 * On the line itself, or on the line immediately above it, so Markdown can use an HTML comment that
 * renders as nothing. Line-level and visible in the diff: a reviewer sees exactly which line was
 * excused and why, which a file-wide exemption hides.
 */
const ALLOW = /encoding-check:\s*allow/;

/**
 * Added lines only. A diff's removed lines may legitimately contain the damage being repaired —
 * refusing those would make it impossible to push the fix for an encoding mistake.
 */
export function findEncodingDamage(diff) {
  const findings = [];
  let file = "(unknown)";
  let exempt = false;
  let previousAllowed = false;

  for (const raw of diff.split("\n")) {
    if (raw.startsWith("+++ b/")) {
      file = raw.slice("+++ b/".length).trim();
      exempt = SELF.some((self) => file.endsWith(self));
      previousAllowed = false;
      continue;
    }
    if (exempt) continue;
    if (!raw.startsWith("+") || raw.startsWith("+++")) continue;

    const line = raw.slice(1);
    const allowed = previousAllowed || ALLOW.test(line);
    previousAllowed = ALLOW.test(line);
    if (allowed) continue;
    if (line.includes(REPLACEMENT)) {
      findings.push({ file, line: line.trim(), reason: "contains U+FFFD, the replacement character" });
      continue;
    }

    for (const quoted of line.match(QUOTED) ?? []) {
      if (QUESTION_RUN.test(quoted)) {
        findings.push({
          file,
          line: line.trim(),
          reason: "a run of question marks inside a string — the signature of Arabic through a shell",
        });
        break;
      }
    }
  }

  return findings;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

// Wrapped rather than top-level `await`, so the export above can be imported by a test runner that
// transforms this file to CommonJS. Runs only when invoked as the hook's helper.
async function main() {
  const findings = findEncodingDamage(await readStdin());
  if (findings.length > 0) {
    console.error("\nRefusing the push: text that looks mangled by a shell.\n");
    for (const finding of findings) {
      console.error(`  ${finding.file}`);
      console.error(`    ${finding.reason}`);
      console.error(`    ${finding.line.slice(0, 120)}\n`);
    }
    console.error("CLAUDE.md: Arabic never travels through a shell payload — file-held literal or");
    console.error("the editor. If this is a false positive, say so in the commit and use --no-verify.\n");
    process.exit(1);
  }
}

if (process.argv[1]?.endsWith("check-encoding.mjs")) {
  void main();
}
