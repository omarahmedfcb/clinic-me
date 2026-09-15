import { cx } from "../lib/cx.ts";

interface SpinnerProps {
  size?: "sm" | "md" | "lg";
  tone?: "primary" | "muted" | "onSolid";
  /** Screen-reader label. Defaults to Arabic "جارٍ التحميل". */
  label?: string;
}

const SIZES = { sm: "size-4 border-2", md: "size-6 border-2", lg: "size-9 border-[3px]" };
const TONES = {
  primary: "border-primary/25 border-t-primary",
  muted: "border-ink-subtle/25 border-t-ink-subtle",
  onSolid: "border-white/35 border-t-white",
};

/**
 * A rotation is direction-agnostic: it does not need mirroring for RTL, so there is deliberately no
 * `dir`-dependent variant here. The border trick (a transparent ring with one coloured edge) keeps
 * it to a single element with no SVG.
 */
export function Spinner({ size = "md", tone = "primary", label = "جارٍ التحميل" }: SpinnerProps) {
  return (
    <span
      role="status"
      aria-label={label}
      className={cx("inline-block rounded-full animate-[spin-slow_0.7s_linear_infinite]", SIZES[size], TONES[tone])}
    />
  );
}
