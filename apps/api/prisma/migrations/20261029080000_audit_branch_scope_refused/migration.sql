-- FORWARD-ONLY. There is no down.sql: PostgreSQL cannot drop a value from an enum, and audit rows
-- carrying it are append-only (D5), so they could not be rewritten to make the value droppable either.
-- Branches step 4b stage 3: a write refused because its row lies outside the caller's branches is
-- recorded. Nothing is written for it, so no trigger sees it; its own action keeps it filterable.
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'BRANCH_SCOPE_REFUSED';
