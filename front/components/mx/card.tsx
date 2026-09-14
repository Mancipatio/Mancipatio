import Link from "next/link";
import type { ReactNode } from "react";
import { cx } from "./cx";

export type CardProps = {
  /** Rendered as an h3. Omit for a card that is pure content. */
  title?: ReactNode;
  /** Convenience: a single paragraph of body copy. */
  body?: ReactNode;
  /** Anything else — usually `<Bullets>`. */
  children?: ReactNode;
  /** Makes the whole card a link; the border darkens on hover. */
  href?: string;
  className?: string;
};

/**
 * White panel, hairline border, sharp corners, no shadow. Inside a dark
 * Section it flips to the navy surface automatically.
 *
 * ```tsx
 * <Card title="Receive income" body="The issuer deposits funds…" />
 * <Card title="Company ownership" body="Convertible into real shares."
 *       href="/markets/types/equity" />
 * <Card title="Structure & protections">
 *   <Bullets items={["Issued through a Serbian SPV…"]} />
 * </Card>
 * ```
 */
export function Card({ title, body, children, href, className }: CardProps) {
  const inner = (
    <>
      {title ? <h3 className="mx-h3">{title}</h3> : null}
      {body ? <p>{body}</p> : null}
      {children}
    </>
  );

  if (href !== undefined) {
    return (
      <Link href={href} className={cx("mx-card", "mx-card--link", className)}>
        {inner}
      </Link>
    );
  }

  return <div className={cx("mx-card", className)}>{inner}</div>;
}
