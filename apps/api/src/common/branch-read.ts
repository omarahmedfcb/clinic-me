// The branch sets a request reads and writes (BRANCHES-DESIGN §4.3, §9 A). Reads: the branch X-Branch-Id
// names, else every branch held, plus suspended ones before their suspension. Writes: active branches only.
import { branchContext } from "./branch-context.ts";
import type { SuspendedBranch } from "./branch-scope.ts";

export interface ReadSet {
  /** Active branches, read in full. */
  active: readonly string[];
  /** Suspended branches, read only for rows dated before `suspendedAt`. */
  suspended: readonly SuspendedBranch[];
}

/** Null outside a request, where an unattended process reads the whole clinic. */
export function readSet(): ReadSet | null {
  const context = branchContext.tryGet();
  if (context === undefined) return null;
  if (context.named === true) return { active: [context.selected], suspended: [] };
  return { active: context.allowed, suspended: context.readSuspended ?? [] };
}

/** The write set: active branches only. A suspended branch takes no new row (ruled 2026-10-30). */
export function writeBranches(): readonly string[] | null {
  return branchContext.tryGet()?.allowed ?? null;
}

/** Every branch id the read covers, suspended included, for code that filters a list it already holds. */
export function readBranches(): readonly string[] | null {
  const set = readSet();
  return set === null ? null : [...set.active, ...set.suspended.map((b) => b.id)];
}

/** A Prisma `where` fragment: active branches in full, a suspended one only before its suspension, by `dateField`. */
export function readBranchWhere(dateField: string): Record<string, unknown> {
  const set = readSet();
  if (set === null) return {};
  if (set.suspended.length === 0) return { branchId: { in: [...set.active] } };
  return {
    OR: [
      { branchId: { in: [...set.active] } },
      ...set.suspended.map((b) => ({ branchId: b.id, [dateField]: { lt: b.suspendedAt } })),
    ],
  };
}

/** Whether a row in `branchId`, dated `at`, is inside the read. */
export function inReadBranches(branchId: string, at?: Date): boolean {
  const set = readSet();
  if (set === null || set.active.includes(branchId)) return true;
  const suspended = set.suspended.find((b) => b.id === branchId);
  return suspended !== undefined && at !== undefined && at < suspended.suspendedAt;
}
