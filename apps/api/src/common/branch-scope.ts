// Which branches a membership may act in, and which one `X-Branch-Id` selects (BRANCHES-DESIGN §4.1).
// Pure: the interceptor loads the facts, this decides; `null` from selectBranch is answered with 404.

export type BranchScope = "ALL" | "SELECTED" | "SCHEDULED";

export const ALL_BRANCHES = "all";

export interface BranchFacts {
  scope: BranchScope;
  activeBranchIds: readonly string[];
  defaultBranchId: string;
  memberBranchIds: readonly string[];
  scheduledBranchIds: readonly string[];
}

export interface TemplateSpan {
  branchId: string;
  validFrom: string;
  validTo: string | null;
}

export interface BranchSelection {
  allowed: string[];
  selected: string;
  isMultiBranch: boolean;
}

export function scheduledTemplateBranches(templates: readonly TemplateSpan[], today: string): string[] {
  const notEnded = templates.filter((t) => t.validTo === null || t.validTo >= today);
  return [...new Set(notEnded.map((t) => t.branchId))];
}

export function allowedBranches(facts: BranchFacts): string[] {
  const active = facts.activeBranchIds;
  if (active.length <= 1) return [...active];
  if (facts.scope === "ALL") return [...active];
  const listed = facts.scope === "SELECTED" ? facts.memberBranchIds : facts.scheduledBranchIds;
  const allowed = active.filter((id) => listed.includes(id));
  if (allowed.length > 0) return allowed;
  return [active.includes(facts.defaultBranchId) ? facts.defaultBranchId : active[0]!];
}

export function selectBranch(facts: BranchFacts, header: string | undefined): BranchSelection | null {
  const allowed = allowedBranches(facts);
  const isMultiBranch = facts.activeBranchIds.length > 1;
  const only = allowed.length === 1 ? allowed[0]! : undefined;

  if (header === undefined || header === ALL_BRANCHES) {
    return { allowed, selected: only ?? ALL_BRANCHES, isMultiBranch };
  }
  const named = header.toLowerCase();
  if (!allowed.includes(named)) return null;
  return { allowed, selected: named, isMultiBranch };
}
