import type { ReactNode } from "react";
import { cx } from "./cx";

/** A single fact tile — navy surface, small square marker, one plain claim. */
export function Fact({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={cx("mx-fact", className)}>{children}</div>;
}

/**
 * The dark fact band: three columns of short, checkable statements. Use it
 * only for facts that are settled — this block's whole value is that every
 * line is verifiable.
 *
 * ```tsx
 * <Section variant="dark">
 *   <Eyebrow>The facts</Eyebrow>
 *   <H2 className="mb-7">The legal anchors behind every token</H2>
 *   <Facts items={[
 *     "Serbian SPV for company ownership, debt and revenue share",
 *     "EUR 3,000,000 maximum issuance per SPV per year",
 *   ]} />
 * </Section>
 * ```
 *
 * The tiles carry their own navy styling, so they read correctly in a light
 * Section too — but the prototype always pairs them with `variant="dark"`.
 */
export function Facts({
  items,
  children,
  className,
}: {
  items?: ReactNode[];
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cx("mx-facts", className)}>
      {items?.map((f, i) => <Fact key={i}>{f}</Fact>)}
      {children}
    </div>
  );
}
