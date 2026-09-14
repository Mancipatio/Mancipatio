import type { ReactNode } from "react";
import { cx } from "./cx";

/**
 * Mono, uppercase, hairline chip.
 *
 * - `default` — neutral metadata.
 * - `stage`   — amber. Reserved for deployment stage ("Solana devnet · v0.1").
 *   Amber means *status*, never decoration, and never an unresolved fact.
 *
 * ```tsx
 * <Badge variant="stage">Solana devnet · v0.1</Badge>
 * ```
 */
export function Badge({
  children,
  variant = "default",
  className,
}: {
  children: ReactNode;
  variant?: "default" | "stage";
  className?: string;
}) {
  return (
    <span
      className={cx("mx-badge", variant === "stage" && "mx-badge--stage", className)}
    >
      {children}
    </span>
  );
}
