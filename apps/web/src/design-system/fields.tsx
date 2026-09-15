import type { InputHTMLAttributes, SelectHTMLAttributes, TextareaHTMLAttributes, ReactNode } from "react";
import { useId } from "react";
import { cx } from "../lib/cx.ts";
import { passwordVisibility } from "./visibility.ts";

/**
 * Form fields: label, hint, error, and the control itself.
 *
 * Every one of these uses logical properties (`ps-`/`pe-`, `text-start`) rather than left/right, so
 * the same stylesheet serves Arabic and English (ARCHITECTURE.md §2: RTL via CSS logical
 * properties, not a mirrored stylesheet). Nothing here needs a `dir` check.
 */

const CONTROL_BASE =
  "w-full rounded-lg border bg-surface text-ink text-sm px-3 py-2.5 text-start " +
  "placeholder:text-ink-subtle transition-colors " +
  "disabled:bg-surface-sunken disabled:text-ink-subtle disabled:cursor-not-allowed";

function controlTone(invalid: boolean): string {
  return invalid
    ? "border-danger focus:border-danger"
    : "border-border-strong hover:border-ink-subtle focus:border-primary";
}

interface FieldShellProps {
  label: string;
  hint?: string;
  error?: string;
  required?: boolean;
  htmlFor: string;
  children: ReactNode;
}

function FieldShell({ label, hint, error, required, htmlFor, children }: FieldShellProps) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={htmlFor} className="text-sm font-medium text-ink">
        {label}
        {required === true && (
          <span className="text-danger ms-1" aria-hidden="true">
            *
          </span>
        )}
      </label>
      {children}
      {error !== undefined ? (
        <p className="text-xs text-danger">{error}</p>
      ) : hint !== undefined ? (
        <p className="text-xs text-ink-muted">{hint}</p>
      ) : null}
    </div>
  );
}

type TextInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, "className" | "id"> & {
  label: string;
  hint?: string;
  error?: string;
  /** Forces the value left-to-right — for phone numbers, ids, and money inside Arabic text. */
  numeric?: boolean;
};

export function TextInput({ label, hint, error, numeric = false, required, ...rest }: TextInputProps) {
  const id = useId();
  return (
    <FieldShell label={label} hint={hint} error={error} required={required} htmlFor={id}>
      <input
        {...rest}
        id={id}
        required={required}
        aria-invalid={error !== undefined || undefined}
        className={cx(CONTROL_BASE, controlTone(error !== undefined), numeric && "[direction:ltr] text-start")}
      />
    </FieldShell>
  );
}

/**
 * Re-exported so callers have one import for the field and its state helper. It is *defined* in
 * `visibility.ts`, which has no React import, so a spec on a runner without `apps/web`'s
 * dependencies can still execute the half where a real bug would hide.
 */
export { passwordVisibility };

type PasswordFieldProps = Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "className" | "id" | "type"
> & {
  label: string;
  hint?: string;
  error?: string;
  /** Translated label for the toggle, chosen by the caller from `passwordVisibility`. */
  toggleLabel: string;
  visible: boolean;
  onToggleVisible: () => void;
};

/**
 * A password field with a show/hide control.
 *
 * ## Why it exists
 *
 * Typing a password blind on a phone produces typos, and a typo here is not free: login is rate
 * limited to ten attempts per fifteen minutes per identifier, so a receptionist can spend three of
 * them on the same mistake and then be locked out of a shift she is already late for. The founder's
 * framing: errors burn the rate limit.
 *
 * ## The details that are easy to get wrong
 *
 * **`inset-inline-end`, never the physical side.** Arabic is the default direction, so an icon
 * pinned to the physical end sits on the wrong side of every screen the clinic actually uses.
 * Tailwind spells the logical property `end-*`, and `web-logical-properties.spec.ts` fails the
 * build for the physical one — it caught the first draft of *this comment*, which named the
 * physical class as an example of what not to write. A scanner cannot tell an example from an
 * instruction, and a guard that could would be a guard with a hole in it.
 *
 * **A real `<button type="button">`, not a span with a click handler.** It has to be reachable by
 * keyboard and announced by a screen reader, and `type="button"` matters inside a form: the default
 * is `submit`, so a span-turned-button would send the login request every time somebody peeked at
 * their password.
 *
 * **Visibility is controlled by the caller.** Not because the caller needs it, but because a
 * self-contained version cannot be tested without a DOM: rendering both states is how the type and
 * the label are proven to move together.
 *
 * **It never touches the value.** Toggling changes `type` and nothing else, so a half-typed
 * password survives a peek. That sounds obvious and is exactly what a naive implementation loses by
 * remounting the input.
 */
export function PasswordField({
  label,
  hint,
  error,
  toggleLabel,
  visible,
  onToggleVisible,
  required,
  ...rest
}: PasswordFieldProps) {
  const id = useId();
  return (
    <FieldShell label={label} hint={hint} error={error} required={required} htmlFor={id}>
      <div className="relative">
        <input
          {...rest}
          id={id}
          required={required}
          type={passwordVisibility(visible).type}
          aria-invalid={error !== undefined || undefined}
          // `pe-11` leaves room for the button at the inline end -- logical padding, so the gap
          // moves to the other side with the direction and never collides with the text.
          className={cx(CONTROL_BASE, controlTone(error !== undefined), "pe-11")}
        />
        <button
          type="button"
          aria-label={toggleLabel}
          aria-pressed={visible}
          onClick={onToggleVisible}
          // `tabIndex` is deliberately not set to -1: the control is part of the form's tab order.
          className="absolute end-1 top-1/2 -translate-y-1/2 rounded-md p-2 text-ink-muted hover:bg-surface-sunken hover:text-ink transition-colors"
        >
          <EyeIcon crossed={visible} />
        </button>
      </div>
    </FieldShell>
  );
}

/** Open eye when hidden, struck-through eye when visible: the icon shows what clicking will undo. */
function EyeIcon({ crossed }: { crossed: boolean }) {
  return (
    <svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path
        d="M1.5 10S4.5 4.5 10 4.5 18.5 10 18.5 10 15.5 15.5 10 15.5 1.5 10 1.5 10Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <circle cx="10" cy="10" r="2.5" stroke="currentColor" strokeWidth="1.5" />
      {crossed && <path d="M4 16 16 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />}
    </svg>
  );
}

type TextareaProps = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "className" | "id"> & {
  label: string;
  hint?: string;
  error?: string;
};

export function Textarea({ label, hint, error, required, rows = 4, ...rest }: TextareaProps) {
  const id = useId();
  return (
    <FieldShell label={label} hint={hint} error={error} required={required} htmlFor={id}>
      <textarea
        {...rest}
        id={id}
        rows={rows}
        required={required}
        aria-invalid={error !== undefined || undefined}
        className={cx(CONTROL_BASE, controlTone(error !== undefined), "resize-y leading-relaxed")}
      />
    </FieldShell>
  );
}

type SelectProps = Omit<SelectHTMLAttributes<HTMLSelectElement>, "className" | "id"> & {
  label: string;
  hint?: string;
  error?: string;
  /**
   * `disabled` renders the option greyed and unselectable rather than removing it.
   *
   * Added for the add-doctor picker, where a member of staff who already has a doctor record
   * cannot be linked a second time. Filtering them out would leave an admin wondering where a
   * colleague went; showing them disabled answers that in place, and the native `<option>` element
   * supports it without a custom listbox.
   */
  options: ReadonlyArray<{ value: string; label: string; disabled?: boolean }>;

  placeholder?: string;
};

/**
 * A styled native `<select>`, not a custom listbox.
 *
 * ARCHITECTURE.md §2 names Radix primitives, and Radix's Select is the right answer once a design
 * calls for something native cannot do (rich option rows, async search). It does not yet, and the
 * native control brings correct RTL, correct keyboard behaviour and the platform's own mobile
 * picker for free. Flagged rather than decided permanently — see the gallery notes.
 */
export function Select({ label, hint, error, options, placeholder, required, ...rest }: SelectProps) {
  const id = useId();
  return (
    <FieldShell label={label} hint={hint} error={error} required={required} htmlFor={id}>
      <div className="relative">
        <select
          {...rest}
          id={id}
          required={required}
          aria-invalid={error !== undefined || undefined}
          className={cx(CONTROL_BASE, controlTone(error !== undefined), "pe-9 appearance-none")}
        >
          {placeholder !== undefined && <option value="">{placeholder}</option>}
          {options.map((option) => (
            <option key={option.value} value={option.value} disabled={option.disabled}>
              {option.label}
            </option>
          ))}
        </select>
        {/*
         * The chevron is a positioned element, not a `background-image`. `background-position` has
         * no logical keyword -- it understands only physical `left`/`right` -- so drawing it as a
         * background meant hardcoding a side, which is correct only while the document direction
         * never changes. `inset-inline-end` (Tailwind `end-*`) flips with the direction on its own,
         * so this needs no `dir` check and keeps the promise made at the top of this file.
         */}
        <svg
          className="pointer-events-none absolute end-[0.85rem] top-1/2 -translate-y-1/2 text-ink-muted"
          width="12"
          height="8"
          viewBox="0 0 12 8"
          fill="none"
          aria-hidden="true"
        >
          <path
            d="M1 1.5 6 6.5l5-5"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </div>
    </FieldShell>
  );
}

interface SearchFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "className" | "type"> {
  /** Accessible label. Visually hidden — a search field's icon and placeholder carry the meaning. */
  label?: string;
}

export function SearchField({ label = "بحث", placeholder = "ابحث بالاسم أو رقم الهاتف", ...rest }: SearchFieldProps) {
  const id = useId();
  return (
    <div className="relative">
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <span className="pointer-events-none absolute start-0 inset-y-0 flex items-center ps-3 text-ink-subtle">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <circle cx="7" cy="7" r="4.75" stroke="currentColor" strokeWidth="1.5" />
          <path d="m10.6 10.6 3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </span>
      <input
        {...rest}
        id={id}
        type="search"
        placeholder={placeholder}
        className={cx(CONTROL_BASE, controlTone(false), "ps-9")}
      />
    </div>
  );
}
