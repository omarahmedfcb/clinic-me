// Branches step 5g: the spec that proves each scoped GET keeps to the caller's branches, and the text it must contain.
// Pure data, so test/unit/branch-read-cases.spec.ts can check it against the registry and the spec files without a database.
export const BRANCH_READ_CASES: Record<string, { spec: string; contains: string }> = {
  "GET /appointments/:id/detail": { spec: "branch-single-reads", contains: '"GET /appointments/:id/detail"' },
  "GET /appointments/:id/visit/:visitId/pricing": { spec: "branch-single-reads", contains: '"GET /appointments/:id/visit/:visitId/pricing"' },
  "GET /charges/:chargeId": { spec: "branch-single-reads", contains: '"GET /charges/:chargeId"' },
  "GET /charges/:chargeId/split": { spec: "branch-single-reads", contains: '"GET /charges/:chargeId/split"' },
  "GET /bot/appointments/:id": { spec: "branch-single-reads", contains: '"GET /bot/appointments/:id"' },
  "GET /availability": { spec: "branch-reads", contains: "/availability" },
  "GET /schedule/day": { spec: "branch-reads", contains: "/schedule/day?" },
  "GET /schedule/day/bookings": { spec: "branch-reads", contains: "/schedule/day/bookings" },
  "GET /schedule/month": { spec: "branch-reads", contains: "/schedule/month" },
  "GET /schedule/range": { spec: "branch-reads", contains: "/schedule/range" },
  "GET /doctors/:doctorId/schedule": { spec: "branch-reads", contains: "/doctors/${clinic.doctorId}/schedule`" },
  "GET /queue/today": { spec: "branch-reads", contains: "/queue/today" },
  "GET /no-shows/pending": { spec: "branch-reads", contains: "/no-shows/pending" },
  "GET /bot/slots": { spec: "branch-reads", contains: "/bot/slots" },
  "GET /payments/overview": { spec: "branch-reports", contains: "/payments/overview" },
  "GET /reports/payments": { spec: "branch-reports", contains: "/reports/payments" },
  "GET /reports/branches": { spec: "branch-comparison", contains: "/reports/branches" },
  "GET /audit-log": { spec: "audit-branch-view", contains: "listAuditLog(" },
  "GET /audit-log/filters": { spec: "audit-branch-view", contains: "auditFilterOptions(" },
};

/** Scoped GETs with no case yet, each waiting on a named ruling. The guard refuses any other gap. */
export const AWAITING_RULING: Record<string, string> = {};
