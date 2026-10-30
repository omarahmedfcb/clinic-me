import { useLocale } from "../../i18n/locale-context.tsx";
import type { QueueCoverage } from "./queue-api.ts";

/**
 * Insurance at the desk. `PHASE-3.md` Q18.
 *
 * Minimal by ruling: the insurer's name and whether the patient is covered. **Not** the policy
 * number and not the validity dates — those live on the profile. This exists to answer one
 * question, "do I ask this person for money", at the moment it is asked.
 *
 * ## Three states, and they must not look alike
 *
 * `LAPSED` is rendered in the warning colour and **names the insurer**, because "your cover with
 * MedRight ended" is a conversation reception can actually have. `NONE` is muted and names nobody,
 * because there is nothing to discuss — the patient pays. Collapsing the two into one grey
 * "not covered" chip would be the same defect as a boolean on the wire: it deletes the distinction
 * at the exact moment it is useful.
 *
 * `COVERED` is deliberately the quietest of the three despite being the good news. It is the
 * ordinary case, and a board where every second row shouts in green trains people to stop reading
 * the rows that do not.
 */
/**
 * Q14, and the status is all of it: never a complaint, a preview or a character count.
 *
 * Absent renders nothing, for the reason `CoverageBadge` below spells out at length — a frontend
 * deployed ahead of its API is an ordinary state during a rollout, and reception's all-day screen
 * must not stop because one badge is missing.
 */
export function VisitStatusBadge({ visitStatus }: { visitStatus: "DRAFT" | "COMPLETED" | null | undefined }) {
  const { t } = useLocale();
  if (visitStatus === undefined || visitStatus === null) return null;
  return (
    <span
      data-testid="visit-status-badge"
      data-visit-status={visitStatus}
      className={
        visitStatus === "DRAFT"
          ? "rounded-full bg-primary-soft px-2 py-0.5 text-xs text-primary"
          : "rounded-full bg-surface-sunken px-2 py-0.5 text-xs text-ink-muted"
      }
    >
      {t(visitStatus === "DRAFT" ? "queue.visit.inProgress" : "queue.visit.done")}
    </span>
  );
}

export function CoverageBadge({ coverage }: { coverage: QueueCoverage | undefined }) {
  const { t } = useLocale();

  /**
   * `QueueEntry.coverage` is not optional in the type, and the API does send it. **A type is a claim
   * about a payload, not a validation of one** — TypeScript describes what the server promises and
   * cannot check what actually arrives.
   *
   * This crashed on 2026-09-02 for exactly that reason: the built frontend carried this badge while
   * the running API was an hour older and had no `coverage` field at all, so `coverage.standing`
   * threw and took the whole board down with it. Reception's all-day screen must not stop because
   * one badge is missing, and a frontend deployed ahead of its API is an ordinary state during a
   * rollout rather than an impossible one.
   *
   * Rendering nothing is the right degradation: an absent badge is invisible, and inventing "no
   * insurance" would be a confident lie about whether to ask someone for money.
   */
  if (coverage === undefined) return null;

  if (coverage.standing === "NONE") {
    return (
      <span className="rounded-full bg-surface-sunken px-2 py-0.5 text-xs text-ink-muted">
        {t("queue.cover.none")}
      </span>
    );
  }

  const lapsed = coverage.standing === "LAPSED";
  return (
    <span
      className={
        lapsed
          ? "inline-flex items-center gap-1 rounded-full bg-warning-soft px-2 py-0.5 text-xs text-warning"
          : "inline-flex items-center gap-1 rounded-full bg-success-soft px-2 py-0.5 text-xs text-success"
      }
      // The insurer's name is user-supplied free text and may be Latin inside an Arabic page, so it
      // is isolated: without <bdi> a name ending in punctuation reorders the label around it.
      title={coverage.insurerName}
    >
      <bdi>{coverage.insurerName}</bdi>
      {" · "}
      {t(lapsed ? "queue.cover.lapsed" : "queue.cover.covered")}
    </span>
  );
}
