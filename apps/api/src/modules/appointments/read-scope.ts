// A doctor's day narrowed to the branches a read covers (BRANCHES-DESIGN §4.3): its templates and extra
// availability. Every-branch exceptions and all the doctor's appointments stay: a doctor is in one place.
import { readBranches } from "../../common/branch-read.ts";
import type { DayPlanInput } from "./domain/types.ts";

export function forReadBranches<T extends Pick<DayPlanInput, "templates" | "breaks" | "exceptions">>(input: T): T {
  const branches = readBranches();
  if (branches === null) return input;
  const templates = input.templates.filter((t) => branches.includes(t.branchId));
  const kept = new Set(templates.map((t) => t.id));
  return {
    ...input,
    templates,
    breaks: input.breaks.filter((b) => kept.has(b.scheduleTemplateId)),
    exceptions: input.exceptions.filter((e) => e.branchId === null || branches.includes(e.branchId)),
  };
}
