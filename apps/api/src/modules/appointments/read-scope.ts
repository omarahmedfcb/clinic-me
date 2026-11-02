// A doctor's day as a read sees it: time offered only in active branches (§9 A), every appointment still busy
// (a doctor is in one place), and one outside the read shown as time only, its detail withheld (§4.3).
import { inReadBranches, readSet } from "../../common/branch-read.ts";
import type { DayDescription } from "./domain/describe-day.ts";
import type { BusyBlock, DayPlanInput } from "./domain/types.ts";

export interface BusyElsewhere {
  start: Date;
  end: Date;
  elsewhere: true;
}

export type DayView = Omit<DayDescription, "busy"> & { busy: (BusyBlock | BusyElsewhere)[] };

export function withBusyElsewhere(day: DayDescription, input: Pick<DayPlanInput, "existingAppointments">): DayView {
  const branchOf = new Map(input.existingAppointments.map((a) => [a.id, a.branchId]));
  return {
    ...day,
    busy: day.busy.map((block) => {
      const branchId = branchOf.get(block.appointmentId);
      return branchId === undefined || inReadBranches(branchId, block.start)
        ? block
        : { start: block.start, end: block.end, elsewhere: true as const };
    }),
  };
}

export function forReadBranches<T extends Pick<DayPlanInput, "templates" | "breaks" | "exceptions">>(input: T): T {
  const set = readSet();
  if (set === null) return input;
  const branches = set.active;
  const templates = input.templates.filter((t) => branches.includes(t.branchId));
  const kept = new Set(templates.map((t) => t.id));
  return {
    ...input,
    templates,
    breaks: input.breaks.filter((b) => kept.has(b.scheduleTemplateId)),
    exceptions: input.exceptions.filter((e) => e.branchId === null || branches.includes(e.branchId)),
  };
}
