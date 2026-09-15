import type { TranslationKey } from "../../i18n/strings.ts";

/**
 * A membership role, in the reader's language.
 *
 * Extracted from `AppShell` on 2026-09-06, when a second surface needed it: the add-doctor picker
 * lists memberships, and a clinic owner who also works the desk appears in that list **twice under
 * the same name** — the case the lifted `(user_id, tenant_id)` constraint made possible. Without
 * the role the two rows are identical and the admin is choosing blind, which is the same problem
 * the membership switcher had and solved the same way.
 *
 * Falls back to the raw role rather than to an empty string. A missing translation should read as
 * `OWNER` — unmistakably "nobody has written this yet" — and not as a blank that looks like data
 * the server failed to send. That is the same rule `t()` itself follows for a missing key.
 */
export function roleLabel(role: string, t: (key: TranslationKey) => string): string {
  const key = `shell.role.${role}` as TranslationKey;
  const label = t(key);
  return label === key ? role : label;
}
