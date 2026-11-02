// An audit event's label, from whether any of its rows predates branches or has no single branch. The
// older fact wins: an event holding both reads as predating branches. Null in a single-branch clinic (§6).
export type EventReach = "UNSCOPED" | "BEFORE_BRANCHES" | null;

export function eventReach(multiBranch: boolean, beforeBranches: boolean, unscoped: boolean): EventReach {
  if (!multiBranch) return null;
  if (beforeBranches) return "BEFORE_BRANCHES";
  return unscoped ? "UNSCOPED" : null;
}
