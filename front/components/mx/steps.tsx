import type { ReactNode } from "react";
import { cx } from "./cx";

export type StepItem = { title: ReactNode; body: ReactNode };

/**
 * One numbered row. The number is mono, indigo and zero-padded to two
 * digits — pass the human number (1, 2, 3), not the string.
 */
export function Step({
  n,
  title,
  children,
  className,
}: {
  n: number;
  title: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cx("mx-step", className)}>
      <div className="mx-step-n">{String(n).padStart(2, "0")}</div>
      <div>
        <h3 className="mx-h3">{title}</h3>
        <p>{children}</p>
      </div>
    </div>
  );
}

/**
 * Numbered process list, ruled top and bottom.
 *
 * ```tsx
 * <Steps
 *   className="mt-7 max-w-[800px]"
 *   items={[
 *     { title: "Onboard", body: "Identity verification and terms." },
 *     { title: "Submit the form", body: "The asset, the rights attached…" },
 *   ]}
 * />
 * ```
 *
 * Only one page may own a given flow — every other page links to it. That
 * single rule is what keeps four competing step-lists from reappearing.
 */
export function Steps({
  items,
  children,
  className,
}: {
  items?: StepItem[];
  /** Pass `<Step>` children instead when the numbering isn't sequential. */
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div className={className}>
      {items?.map((s, i) => (
        <Step key={i} n={i + 1} title={s.title}>
          {s.body}
        </Step>
      ))}
      {children}
    </div>
  );
}
