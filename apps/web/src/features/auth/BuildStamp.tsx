// Shows which commit the reviewed build came from, so stale-build feedback is impossible to give.
// Renders nothing when unstamped, because a footer claiming "dev" would be a claim nobody checked.

const COMMIT = import.meta.env.VITE_BUILD_COMMIT ?? "";
const BUILT_AT = import.meta.env.VITE_BUILD_TIME ?? "";
const BRANCH = import.meta.env.VITE_BUILD_BRANCH ?? "";

/**
 * The short form for the sidebar's foot — the commit alone, or nothing.
 *
 * Deliberately not the full stamp: the login footer has room for branch, commit and build time, and
 * a sidebar does not. The commit is the part a clinic can read back over the phone.
 */
export const BUILD_VERSION = COMMIT === "" ? "" : `build ${COMMIT}`;

export function BuildStamp() {
  if (COMMIT === "" && BUILT_AT === "" && BRANCH === "") return null;

  const built = BUILT_AT === "" ? null : new Date(BUILT_AT);
  const when =
    built === null || Number.isNaN(built.getTime())
      ? BUILT_AT
      : built.toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });

  return (
    <p dir="ltr" className="text-center text-[11px] text-ink-muted/70 tabular-nums">
      {[BRANCH, COMMIT, when].filter((part) => part !== "").join(" · ")}
    </p>
  );
}
