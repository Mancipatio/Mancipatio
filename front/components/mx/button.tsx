import Link from "next/link";
import type { ReactNode } from "react";
import { cx } from "./cx";

export type ButtonProps = {
  children: ReactNode;
  /** Renders a `next/link` instead of a `<button>`. */
  href?: string;
  /** solid = ink fill (primary), ghost = hairline outline (secondary). */
  variant?: "solid" | "ghost";
  size?: "md" | "sm";
  className?: string;
  /** `<button>` only. */
  type?: "button" | "submit";
  onClick?: () => void;
  disabled?: boolean;
  target?: string;
  rel?: string;
  "aria-label"?: string;
  "aria-expanded"?: boolean;
  "aria-controls"?: string;
};

/**
 * The site's only button. Two variants, two sizes, nothing else — in a dark
 * Section both flip automatically via the `.mx-sec--dark` cascade.
 *
 * ```tsx
 * <Button href="/apply">Apply to issue</Button>
 * <Button href="/markets/types" variant="ghost">See the eight instruments</Button>
 * <Button type="submit" size="sm">Submit application</Button>
 * ```
 */
export function Button({
  children,
  href,
  variant = "solid",
  size = "md",
  className,
  type = "button",
  onClick,
  disabled = false,
  target,
  rel,
  "aria-label": ariaLabel,
  "aria-expanded": ariaExpanded,
  "aria-controls": ariaControls,
}: ButtonProps) {
  const cls = cx(
    "mx-btn",
    variant === "ghost" && "mx-btn--ghost",
    size === "sm" && "mx-btn--sm",
    className,
  );

  if (href !== undefined) {
    return (
      <Link
        href={href}
        className={cls}
        target={target}
        rel={rel}
        aria-label={ariaLabel}
      >
        {children}
      </Link>
    );
  }

  return (
    <button
      type={type}
      className={cls}
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel}
      aria-expanded={ariaExpanded}
      aria-controls={ariaControls}
    >
      {children}
    </button>
  );
}

/** Horizontal button group with the prototype's 26px top offset. */
export function ButtonRow({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={cx("mx-btns", className)}>{children}</div>;
}

/**
 * Indigo inline link — the only place indigo is used as text. Ends with an
 * arrow by convention when it moves the reader to another page.
 *
 * ```tsx
 * <TextLink href="/legal-structure">How the rights bind the issuer →</TextLink>
 * ```
 */
export function TextLink({
  href,
  children,
  className,
  target,
  rel,
}: {
  href: string;
  children: ReactNode;
  className?: string;
  target?: string;
  rel?: string;
}) {
  return (
    <Link href={href} className={cx("mx-link", className)} target={target} rel={rel}>
      {children}
    </Link>
  );
}
