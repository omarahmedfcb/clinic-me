import * as Dialog from "@radix-ui/react-dialog";
import type { ReactNode } from "react";
import { Button } from "./Button.tsx";
import { cx } from "../lib/cx.ts";

/**
 * Modal, Drawer and ConfirmDialog — all three on Radix Dialog (ARCHITECTURE.md §2).
 *
 * Radix earns its place here specifically: focus trapping, restoring focus to the trigger on close,
 * Escape handling, `aria-modal` wiring, scroll locking and inert background content are each easy
 * to get subtly wrong by hand, and all of them are invisible until a keyboard user hits them. The
 * styling is entirely ours; Radix contributes no appearance.
 *
 * Every position is expressed with logical properties, so the drawer opens from the right in Arabic
 * and the left in English without a second stylesheet.
 */

const OVERLAY =
  "fixed inset-0 bg-ink/35 backdrop-blur-[1px] animate-[overlay-in_140ms_ease-out]";

function CloseButton({ label = "إغلاق" }: { label?: string }) {
  return (
    <Dialog.Close
      aria-label={label}
      className="rounded-md p-1.5 text-ink-muted hover:bg-surface-sunken hover:text-ink transition-colors"
    >
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
      </svg>
    </Dialog.Close>
  );
}

interface ModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
}

/**
 * **Every modal in the application had this bug, and one dialog found it — 2026-09-06.**
 *
 * `Modal` was `h-fit` with no height cap and no internal scroll, so a dialog taller than the
 * viewport simply overflowed it. The footer is the last child, which means **the confirm button
 * went below the fold and could not be reached at all** — not scrolled to, not tabbed to a visible
 * position, not resized into view. On a 495px viewport the add-doctor form's only usable exit was
 * Cancel.
 *
 * The founder's ruling on how to record it: *"that's a whole-app bug found by building one dialog.
 * Note it in the design system file: every modal had it, and a confirm button below the fold on a
 * 495px viewport is unreachable, not merely ugly."*
 *
 * The distinction is the point. A cramped dialog is a cosmetic complaint that waits its turn; a
 * dialog whose primary action cannot be clicked is a dead end, and the only difference between the
 * two is a viewport height nobody on the team happened to be using. The add-doctor form was the
 * first modal with enough fields to cross the line — it did not introduce the fault, it revealed
 * one that had been shipped in the shared component since it was written.
 */
export function Modal({ open, onOpenChange, title, description, children, footer }: ModalProps) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className={OVERLAY} />
        <Dialog.Content
          // Centred with `inset-0` + `m-auto` + `h-fit` rather than `top-1/2 start-1/2` plus a
          // translate. `translate` is a physical transform with no logical equivalent, so the
          // translate approach needs opposite signs in RTL and LTR and is one `dir` change away
          // from sitting off-centre. Auto margins have no direction at all.
          // `max-h` + a scrolling body, not `h-fit` alone -- see the note above the component for
          // what that was costing and why it counted as unreachable rather than untidy.
          //
          // `dvh` rather than `vh`: on mobile Safari `vh` is the *largest* viewport height, so the
          // URL bar would eat exactly the strip the footer sits in and reproduce the same bug on
          // the device it is hardest to notice on.
          className={cx(
            "fixed inset-0 m-auto h-fit max-h-[calc(100dvh-2rem)] w-[min(32rem,calc(100vw-2rem))]",
            "flex flex-col overflow-hidden",
            "rounded-card bg-surface shadow-xl border border-border",
            "animate-[dialog-in_160ms_ease-out]",
          )}
        >
          {/* `shrink-0` on the header and footer so the body is the only part that gives. */}
          <div className="flex shrink-0 items-start justify-between gap-4 border-b border-border px-5 py-4">
            <div className="flex flex-col gap-1">
              <Dialog.Title className="text-base font-semibold text-ink">{title}</Dialog.Title>
              {description !== undefined && (
                <Dialog.Description className="text-sm text-ink-muted">{description}</Dialog.Description>
              )}
            </div>
            <CloseButton />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4 text-sm text-ink">{children}</div>
          {footer !== undefined && (
            <div className="flex shrink-0 flex-wrap justify-end gap-2 border-t border-border px-5 py-4">
              {footer}
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

interface DrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
}

/**
 * Slides in from the inline-start edge: the right in Arabic, the left in English. Tailwind spells
 * that `start-0`, which compiles to `inset-inline-start`. It is NOT `inset-inline-start-*` -- that
 * is the raw CSS property name, not a utility, so Tailwind generates no rule for it and the drawer
 * silently loses every offset. It then renders `fixed` at its static position, off-screen, which
 * looked like a blank screen rather than a broken class (fixed 2026-08-31).
 */
export function Drawer({ open, onOpenChange, title, children, footer }: DrawerProps) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className={OVERLAY} />
        <Dialog.Content
          className={cx(
            "fixed inset-y-0 start-0 w-[min(26rem,100vw)]",
            "flex flex-col bg-surface shadow-2xl border-e border-border",
            "animate-[drawer-in_180ms_ease-out]",
          )}
        >
          <div className="flex items-center justify-between gap-4 border-b border-border px-5 py-4">
            <Dialog.Title className="text-base font-semibold text-ink">{title}</Dialog.Title>
            <CloseButton />
          </div>
          <div className="flex-1 overflow-y-auto px-5 py-4 text-sm text-ink">{children}</div>
          {footer !== undefined && (
            <div className="flex flex-wrap justify-end gap-2 border-t border-border px-5 py-4">{footer}</div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: "danger" | "primary";
  onConfirm: () => void;
}

/**
 * Separate from Modal on purpose. A confirmation has a fixed shape — one question, two answers, a
 * destructive default that must be the *non*-preferred one — and giving it its own component stops
 * that shape being reinvented, slightly differently, on every screen that deletes something.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  message,
  confirmLabel = "تأكيد",
  cancelLabel = "إلغاء",
  tone = "danger",
  onConfirm,
}: ConfirmDialogProps) {
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            {cancelLabel}
          </Button>
          <Button
            variant={tone === "danger" ? "danger" : "primary"}
            onClick={() => {
              onConfirm();
              onOpenChange(false);
            }}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <p className="leading-relaxed text-ink-muted">{message}</p>
    </Modal>
  );
}
