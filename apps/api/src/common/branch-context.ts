// The request's branch selection, bound by BranchScopeInterceptor. withTenant() binds the single
// selected branch for the audit trigger; scoped services read it from here (branches steps 4 and 5).
import { AsyncLocalStorage } from "node:async_hooks";
import { ALL_BRANCHES, type BranchSelection } from "./branch-scope.ts";

export interface BranchSummary {
  id: string;
  name: string;
  nameEn: string | null;
  isDefault: boolean;
}

export interface BranchContext extends BranchSelection {
  branches: BranchSummary[];
}

/** Bound for an HTTP request with no clinic membership behind it: nothing is allowed. */
export const NO_MEMBERSHIP: BranchContext = { allowed: [], selected: ALL_BRANCHES, isMultiBranch: false, branches: [] };

const storage = new AsyncLocalStorage<BranchContext>();

export const branchContext = {
  run<T>(context: BranchContext, fn: () => T): T {
    return storage.run(context, fn);
  },

  tryGet(): BranchContext | undefined {
    return storage.getStore();
  },

  /** True only outside any request: an unattended process (a job, a seed) acts for the whole clinic. */
  allows(branchId: string): boolean {
    const context = storage.getStore();
    return context === undefined || context.allowed.includes(branchId);
  },

  selectedSingle(): string | undefined {
    const context = storage.getStore();
    return context === undefined || context.selected === ALL_BRANCHES ? undefined : context.selected;
  },
};
