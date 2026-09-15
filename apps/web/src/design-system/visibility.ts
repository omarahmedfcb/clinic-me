/**
 * The password field's visible/hidden pair, as data rather than as two branches at the call site.
 *
 * ## Why it is a `.ts` file of its own rather than a few lines inside `fields.tsx`
 *
 * So that it can be **imported and executed by a test that runs on CI**. `apps/api`'s jest is where
 * the `web-*` specs live, its CI job installs only `apps/api`'s dependencies, and `apps/web` is not
 * on that runner at all — so a spec that imports a `.tsx` file needs React and cannot have it. A
 * plain module with no React import can be imported from anywhere, and this is the half of the
 * toggle where a real bug would hide: the input type and the label must move together, and the
 * silent failure is an icon that flips while the field stays `type="password"`.
 *
 * That is the same reason `prisma/seed/generate.ts` was split out of `seed-clinical.ts`, and the
 * same rule `CLAUDE.md` states about import graphs: if a spec cannot load a module in the
 * environment CI actually has, the fix is to split the pure part out, not to enrich the runner.
 */
export const passwordVisibility = (visible: boolean) =>
  visible
    ? { type: "text" as const, labelKey: "login.password.hide" as const }
    : { type: "password" as const, labelKey: "login.password.show" as const };
