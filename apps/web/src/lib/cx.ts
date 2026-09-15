/**
 * Joins class names, dropping anything falsy. Small enough not to justify a dependency
 * (`clsx`/`classnames` do exactly this), and keeping it local means one fewer package in a tree
 * the founder has to review.
 */
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}
