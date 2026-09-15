import type { ReactNode } from "react";
import { cx } from "../lib/cx.ts";
import type { AppointmentStatus } from "../domain/appointment-status.ts";
import { useLocale } from "../i18n/locale-context.tsx";

/** Card, StatusBadge, EmptyState, DataTable — the read-only half of the design system. */

interface CardProps {
  title?: string;
  subtitle?: string;
  actions?: ReactNode;
  children: ReactNode;
  padded?: boolean;
}

export function Card({ title, subtitle, actions, children, padded = true }: CardProps) {
  return (
    <section className="rounded-card border border-border bg-surface-raised shadow-[0_1px_2px_rgba(18,32,31,0.04)]">
      {(title !== undefined || actions !== undefined) && (
        <header className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
          <div className="flex flex-col gap-0.5">
            {title !== undefined && <h3 className="text-sm font-semibold text-ink">{title}</h3>}
            {subtitle !== undefined && <p className="text-xs text-ink-muted">{subtitle}</p>}
          </div>
          {actions}
        </header>
      )}
      <div className={cx(padded && "px-5 py-4")}>{children}</div>
    </section>
  );
}

/**
 * Status colours, ruled 2026-08-29.
 *
 * ```
 * BOOKED           amber (own token, not `warning`)  not yet confirmed
 * CONFIRMED        green, lightest   * ARRIVED          green, mid        > one hue darkening as the patient nears the door
 * WAITING          green, darkest   /
 * IN_CONSULTATION  active grey      the one happening now: different, not darkest
 * PAUSED           blue             stepped out for imaging or a lab (Q34)
 * COMPLETED        no fill          outline and neutral text only
 * CANCELLED        red + struck through
 * NO_SHOW          red
 * ```
 *
 * ## The three greens are spaced on deltaE, not on lightness
 *
 * Three tints of one hue only read as three things if they are far enough apart to survive a chip
 * two centimetres wide. They used to sit at L* 93.0 / 68.9 / 44.9 -- an even 24 points per step,
 * correctly measured, and still only two distinguishable greens on screen, because chroma jumped
 * 37 points on the first step and none on the second. As deltaE76 that ramp was 44.3 / 24.9 / 35.9.
 * Re-spaced on deltaE it is 30.7 / 31.2 / 28.5; see `index.css` for the full derivation. The
 * darkest is still a solid fill with white text rather than a third pale wash.
 *
 * ## Why CANCELLED is struck through and NO_SHOW is not
 *
 * Both are red, so colour no longer separates them, and reception has to tell them apart: one
 * patient told us and one vanished, and only the second is worth chasing.
 *
 * A strike-through carries that difference without being taught. It means withdrawn, called off,
 * *unmade* -- which is what a cancellation is. A no-show is the opposite shape: the appointment
 * stood, the slot was held, nobody came. Striking that out would say the wrong thing.
 *
 * It was chosen over the two alternatives on cost as well as meaning. An icon needs a legend and
 * eats horizontal space a chip does not have -- Arabic patient names are long and the chip is
 * already the tightest element on the screen. A second word ("cancelled by patient") needs
 * translating, wraps, and says in ten characters what one line says instantly. The strike-through
 * costs no width, needs no key, and survives a greyscale print, which the red does not.
 *
 * The text label remains underneath it either way, so nothing depends on the reader noticing.
 */
const STATUS_TONES: Record<AppointmentStatus, string> = {
  BOOKED: "bg-amber-soft text-amber-ink border-amber/40",
  CONFIRMED: "bg-green-soft text-green-ink border-green-mid/40",
  ARRIVED: "bg-green-mid text-green-ink border-green-strong/40",
  WAITING: "bg-green-strong text-white border-green-strong",
  IN_CONSULTATION: "bg-active-grey text-white border-active-grey",
  // Q34, and blue rather than a grey or a green. The greens are the ramp towards the door and this
  // patient has gone the other way; grey is the consultation happening now, which this is not. It
  // must also survive as a bar, where fill is the only channel — `status-colour-separation.spec.ts`
  // measured the first attempt at deltaE 0.0 against IN_CONSULTATION and refused it.
  PAUSED: "bg-info-soft text-info border-info/30",
  // "No colour" is a fill decision, not an absence of styling: it still needs a border to read as
  // a badge rather than as stray text next to seven that do.
  COMPLETED: "bg-transparent text-ink-muted border-border-strong",
  CANCELLED: "bg-danger-soft text-danger border-danger/30",
  NO_SHOW: "bg-danger-soft text-danger border-danger/30",
};

/** The one status whose meaning is "this was unmade". See the note above. */
const STRUCK_THROUGH: ReadonlySet<AppointmentStatus> = new Set<AppointmentStatus>(["CANCELLED"]);

export function StatusBadge({ status }: { status: AppointmentStatus }) {
  // The interface language, not the module-level `t` -- that one is bound to Arabic at import time,
  // so an English day view rendered Arabic status labels next to English column headings.
  const { t } = useLocale();

  return (
    <span
      className={cx(
        "inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium whitespace-nowrap",
        STATUS_TONES[status],
        STRUCK_THROUGH.has(status) && "line-through decoration-from-font",
      )}
    >
      {t(`appointment.status.${status}`)}
    </span>
  );
}

interface EmptyStateProps {
  title: string;
  message: string;
  action?: ReactNode;
}

export function EmptyState({ title, message, action }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-12 text-center">
      <div className="flex size-12 items-center justify-center rounded-full bg-surface-sunken text-ink-subtle">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path
            d="M5 7h14M5 12h9M5 17h6"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
          />
        </svg>
      </div>
      <h4 className="text-sm font-semibold text-ink">{title}</h4>
      <p className="max-w-sm text-sm leading-relaxed text-ink-muted">{message}</p>
      {action}
    </div>
  );
}

export interface Column<Row> {
  key: string;
  header: string;
  /** Right-aligned in Arabic by default; pass "end" for numeric columns that should hug the far edge. */
  align?: "start" | "end";
  render: (row: Row) => ReactNode;
  /** Prevents a long Arabic name from being wrapped into three lines in a narrow column. */
  width?: string;
}

interface DataTableProps<Row> {
  columns: ReadonlyArray<Column<Row>>;
  rows: readonly Row[];
  rowKey: (row: Row) => string;
  empty?: ReactNode;
  caption?: string;
}

/**
 * The table scrolls inside its own container rather than pushing the page sideways. In RTL a
 * horizontally overflowing table is particularly nasty: the page scrolls the *other* way from what
 * the reader expects, and the first column — the one carrying the patient name — is the one that
 * disappears.
 */
export function DataTable<Row>({ columns, rows, rowKey, empty, caption }: DataTableProps<Row>) {
  if (rows.length === 0 && empty !== undefined) return <>{empty}</>;

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        {caption !== undefined && <caption className="sr-only">{caption}</caption>}
        <thead>
          <tr className="border-b border-border">
            {columns.map((column) => (
              <th
                key={column.key}
                scope="col"
                style={column.width !== undefined ? { width: column.width } : undefined}
                className={cx(
                  "px-4 py-3 text-xs font-semibold text-ink-muted whitespace-nowrap",
                  column.align === "end" ? "text-end" : "text-start",
                )}
              >
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={rowKey(row)} className="border-b border-border last:border-0 hover:bg-surface-sunken/60">
              {columns.map((column) => (
                <td
                  key={column.key}
                  className={cx("px-4 py-3 align-middle", column.align === "end" ? "text-end" : "text-start")}
                >
                  {column.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
