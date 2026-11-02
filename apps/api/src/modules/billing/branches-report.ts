// The comparison per branch (BRANCHES-DESIGN §5, step 5e): each row is that branch's own payments report,
// run under a context that reads only it, so the two cannot disagree. Suspended branches count before suspension.
import { branchContext, type BranchContext } from "../../common/branch-context.ts";
import { readSet } from "../../common/branch-read.ts";
import { ALL_BRANCHES } from "../../common/branch-scope.ts";
import { withTenant } from "../../prisma/with-tenant.ts";
import { getPaymentsReport, type ReportCaller, type ReportPeriod } from "./payments-report.ts";

export interface BranchFigures {
  branchId: string;
  name: string;
  nameEn: string | null;
  suspended: boolean;
  collectedMinor: number;
  chargedMinor: number;
  outstandingMinor: number;
  charges: number;
}

export interface BranchesReport {
  period: ReportPeriod;
  on: string;
  from: string;
  to: string;
  scope: "CLINIC" | "OWN";
  branches: BranchFigures[];
}

export type BranchesReportResult = { ok: true; value: BranchesReport } | { ok: false; code: "INVALID_PERIOD" };

export async function getBranchesReport(
  caller: ReportCaller,
  input: { period: ReportPeriod; on?: string },
  now: Date,
): Promise<BranchesReportResult> {
  const outer = branchContext.tryGet();
  const set = readSet();
  if (outer === undefined || set === null) throw new Error("getBranchesReport runs inside a request's branch context");

  const ids = [...set.active, ...set.suspended.map((b) => b.id)];
  const rows = await withTenant(caller.tenantId, caller.actor, (tx) =>
    tx.branch.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true, nameEn: true },
      orderBy: [{ isDefault: "desc" }, { name: "asc" }],
    }),
  );

  const onlyThis = (branchId: string): BranchContext => {
    const suspended = set.suspended.find((b) => b.id === branchId);
    return suspended === undefined
      ? { ...outer, allowed: [branchId], selected: branchId, readSuspended: [], named: false }
      : { ...outer, allowed: [], selected: ALL_BRANCHES, readSuspended: [suspended], named: false };
  };

  const branches: BranchFigures[] = [];
  let shape: Omit<BranchesReport, "branches"> | null = null;
  for (const row of rows) {
    const result = await branchContext.run(onlyThis(row.id), () => getPaymentsReport(caller, input, now));
    if (!result.ok) return result;
    const { period, on, from, to, scope, collectedMinor, outstandingMinor, byDoctor } = result.value;
    shape ??= { period, on, from, to, scope };
    branches.push({
      branchId: row.id,
      name: row.name,
      nameEn: row.nameEn,
      suspended: set.suspended.some((b) => b.id === row.id),
      collectedMinor,
      chargedMinor: byDoctor.reduce((total, doctor) => total + doctor.chargedMinor, 0),
      outstandingMinor,
      charges: byDoctor.reduce((total, doctor) => total + doctor.charges, 0),
    });
  }

  if (shape === null) {
    const empty = await branchContext.run({ ...outer, allowed: [], readSuspended: [], named: false }, () => getPaymentsReport(caller, input, now));
    if (!empty.ok) return empty;
    const { period, on, from, to, scope } = empty.value;
    shape = { period, on, from, to, scope };
  }
  return { ok: true, value: { ...shape, branches } };
}
