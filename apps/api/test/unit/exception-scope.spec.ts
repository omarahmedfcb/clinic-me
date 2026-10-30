import { resolveExceptionScope, type ScopeRequest } from "../../src/modules/schedules/exception-scope.ts";

const A = "branch-a";
const B = "branch-b";
const ask = (over: Partial<ScopeRequest>): ScopeRequest => ({ type: "BLOCKED", doctorId: null, branchId: null, scope: null, ...over });

describe("an exception's reach, ruled 2026-10-29", () => {
  const cases: [string, ScopeRequest, readonly string[], ReturnType<typeof resolveExceptionScope>][] = [
    ["a named branch is that branch", ask({ branchId: B }), [A, B], { ok: true, scope: "ONE_BRANCH", branchId: B }],
    ["every branch and a branch at once is a contradiction", ask({ branchId: B, scope: "EVERY_BRANCH" }), [A, B], { ok: false, code: "INVALID_FIELD" }],

    ["a doctor's absence is every branch by default", ask({ doctorId: "d" }), [A, B], { ok: true, scope: "EVERY_BRANCH", branchId: null }],
    ["even in a single-branch clinic, so it stays right when a second opens", ask({ doctorId: "d" }), [A], { ok: true, scope: "EVERY_BRANCH", branchId: null }],
    ["a doctor's absence asked as one branch, with two branches, must name it", ask({ doctorId: "d", scope: "ONE_BRANCH" }), [A, B], { ok: false, code: "BRANCH_REQUIRED" }],

    ["a closure with no doctor has no default once there are two branches", ask({}), [A, B], { ok: false, code: "BRANCH_REQUIRED" }],
    ["a closure stated as every branch is every branch", ask({ scope: "EVERY_BRANCH" }), [A, B], { ok: true, scope: "EVERY_BRANCH", branchId: null }],
    ["a closure in a single-branch clinic is that branch, never every branch", ask({ type: "HOLIDAY" }), [A], { ok: true, scope: "ONE_BRANCH", branchId: A }],

    ["extra availability in a single-branch clinic is that branch", ask({ type: "EXTRA_AVAILABILITY", doctorId: "d" }), [A], { ok: true, scope: "ONE_BRANCH", branchId: A }],
    ["extra availability with two branches must name one", ask({ type: "EXTRA_AVAILABILITY", doctorId: "d" }), [A, B], { ok: false, code: "BRANCH_REQUIRED" }],
    ["extra availability can never be every branch", ask({ type: "EXTRA_AVAILABILITY", doctorId: "d", scope: "EVERY_BRANCH" }), [A], { ok: false, code: "BRANCH_REQUIRED" }],
  ];

  test.each(cases)("%s", (_name, request, branches, expected) => {
    expect(resolveExceptionScope(request, branches)).toEqual(expected);
  });

  test("no request in a single-branch clinic ever yields an every-branch closure", () => {
    for (const type of ["BLOCKED", "HOLIDAY"] as const) {
      expect(resolveExceptionScope(ask({ type }), [A])).toEqual({ ok: true, scope: "ONE_BRANCH", branchId: A });
    }
  });
});
