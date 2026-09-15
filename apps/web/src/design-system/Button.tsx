import type { ButtonHTMLAttributes, ReactNode } from "react";
import { Spinner } from "./Spinner.tsx";
import { cx } from "../lib/cx.ts";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className"> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  /** Rendered on the inline-start side — the right in Arabic, the left in English. */
  icon?: ReactNode;
  fullWidth?: boolean;
  children: ReactNode;
}

const VARIANTS: Record<ButtonVariant, string> = {
  primary: "bg-primary text-white hover:bg-primary-hover border border-transparent",
  secondary: "bg-surface text-ink border border-border-strong hover:bg-surface-sunken",
  ghost: "bg-transparent text-primary border border-transparent hover:bg-primary-soft",
  danger: "bg-danger text-white hover:bg-danger-hover border border-transparent",
};

const SIZES: Record<ButtonSize, string> = {
  sm: "text-sm px-3 py-1.5 gap-1.5",
  md: "text-sm px-4 py-2.5 gap-2",
  lg: "text-base px-5 py-3 gap-2.5",
};

/**
 * `loading` keeps the button's width stable by leaving the label in place and putting the spinner
 * beside it, rather than swapping the label out. A button that changes width mid-click moves the
 * things next to it, and in a queue screen that means the receptionist's next target has shifted.
 */
export function Button({
  variant = "primary",
  size = "md",
  loading = false,
  icon,
  fullWidth = false,
  disabled,
  children,
  ...rest
}: ButtonProps) {
  const isDisabled = disabled === true || loading;

  return (
    <button
      {...rest}
      disabled={isDisabled}
      aria-busy={loading || undefined}
      className={cx(
        "inline-flex items-center justify-center rounded-lg font-medium transition-colors",
        "disabled:cursor-not-allowed disabled:opacity-50",
        VARIANTS[variant],
        SIZES[size],
        fullWidth && "w-full",
      )}
    >
      {loading ? <Spinner size="sm" tone={variant === "secondary" || variant === "ghost" ? "primary" : "onSolid"} /> : icon}
      <span>{children}</span>
    </button>
  );
}
