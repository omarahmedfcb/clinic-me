import { Button } from "../../design-system/Button.tsx";
import { Card } from "../../design-system/display.tsx";
import { useLocale } from "../../i18n/locale-context.tsx";
import type { NoShowCandidate, QueueEntry, QueueMove } from "./queue-api.ts";
import { clockOf } from "./queue-moves.ts";

export function NoShowCard({
  candidates,
  rows,
  busyId,
  act,
}: {
  candidates: NoShowCandidate[];
  rows: QueueEntry[];
  busyId: string | null;
  act: (entry: QueueEntry, move: QueueMove) => Promise<void>;
}) {
  const { t, locale } = useLocale();
  return (
      <Card title={t("queue.noShow.title")}>
        <p className="text-sm text-ink-muted">{t("queue.noShow.subtitle")}</p>
        {candidates.length === 0 ? (
          <p className="py-3 text-sm text-ink-subtle">{t("queue.noShow.empty")}</p>
        ) : (
          <>
            <p className="py-2 text-xs text-warning">{t("queue.noShow.warning")}</p>
            <ul className="flex flex-col">
              {candidates.map((candidate) => {
                /*
                 * The row as the queue is currently showing it, so `expectedStatus` is the real
                 * one. A candidate is BOOKED *or* CONFIRMED and `/no-shows/pending` does not say
                 * which — hardcoding either would send a wrong expectation half the time and the
                 * compare-and-set would correctly refuse an action nobody got wrong. Both statuses
                 * are on the queue, so the row is always in the list this screen already has.
                 */
                const entry = rows.find((r) => r.appointmentId === candidate.appointmentId);
                return (
                  <li
                    key={candidate.appointmentId}
                    className="flex flex-wrap items-center gap-3 border-b border-border py-3 last:border-0"
                  >
                    <div className="min-w-48 flex-1">
                      <div className="font-medium text-ink">{candidate.patientName}</div>
                      <div className="text-xs text-ink-muted">
                        {t("queue.noShow.since").replace("{time}", clockOf(candidate.eligibleSince, locale))}
                      </div>
                    </div>
                    <Button
                      size="sm"
                      variant="danger"
                      disabled={entry === undefined || busyId === candidate.appointmentId}
                      onClick={() => {
                        if (entry !== undefined) void act(entry, "no-show");
                      }}
                    >
                      {t("queue.noShow.confirm")}
                    </Button>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </Card>
  );
}
