// Types for check-encoding.mjs, which stays plain JavaScript because the git hook runs it with bare
// node — no build step is available at push time.

export interface EncodingFinding {
  /** Repository-relative path, as the diff names it. */
  file: string;
  /** The offending added line, trimmed. */
  line: string;
  reason: string;
}

/** Scans a unified diff's **added** lines. Empty means nothing that looks shell-mangled. */
export function findEncodingDamage(diff: string): EncodingFinding[];
