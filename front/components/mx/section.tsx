import type { ReactNode } from "react";
import { cx } from "./cx";

/**
 * Page measure. 1120px, 24px gutters — the only horizontal container on the
 * marketing site. `Section` renders one for you; use `Wrap` directly only
 * when you need a second container inside a full-bleed band.
 */
export function Wrap({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={cx("mx-wrap", className)}>{children}</div>;
}

export type SectionProps = {
  children: ReactNode;
  /** "dark" paints the navy band and flips every primitive inside it. */
  variant?: "light" | "dark";
  /** First section on the page: no top rule, slightly tighter top padding. */
  first?: boolean;
  /** Anchor target, e.g. `id="how-it-works"`. */
  id?: string;
  /** Skip the built-in `Wrap` (full-bleed content supplies its own). */
  bare?: boolean;
  className?: string;
};

/**
 * A horizontal band separated from its neighbours by a single hairline.
 * Sections are the only vertical rhythm on the site — do not add margins
 * between blocks, add another Section.
 *
 * ```tsx
 * <Section variant="dark">
 *   <Eyebrow>The facts</Eyebrow>
 *   <H2>The legal anchors behind every token</H2>
 *   <Facts items={["Serbian SPV for company ownership…"]} />
 * </Section>
 * ```
 */
export function Section({
  children,
  variant = "light",
  first = false,
  id,
  bare = false,
  className,
}: SectionProps) {
  return (
    <section
      id={id}
      className={cx(
        "mx-sec",
        first && "mx-sec--first",
        variant === "dark" && "mx-sec--dark",
        className,
      )}
    >
      {bare ? children : <Wrap>{children}</Wrap>}
    </section>
  );
}

/** Mono, uppercase, letter-spaced kicker above a heading. */
export function Eyebrow({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return <p className={cx("mx-eyebrow", className)}>{children}</p>;
}

export function H2({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return <h2 className={cx("mx-h2", className)}>{children}</h2>;
}

export function H3({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return <h3 className={cx("mx-h3", className)}>{children}</h3>;
}

/** Oversized intro paragraph. One per page, under the h1. */
export function Lede({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return <p className={cx("mx-lede", className)}>{children}</p>;
}

/** Body copy. Capped at 38em — do not widen it. */
export function Body({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return <p className={cx("mx-body", className)}>{children}</p>;
}

/** 13px note under a card, table or form. */
export function Small({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return <p className={cx("mx-small", className)}>{children}</p>;
}

/**
 * The top of a page: its own first Section with eyebrow, h1 and lede.
 * `children` lands under the lede — typically a `ButtonRow` and a stage note.
 *
 * ```tsx
 * <PageHeader eyebrow="Company ownership" title="Convertible into real shares"
 *   lede="A token carrying the right to become an actual shareholder.">
 *   <ButtonRow>
 *     <Button href={MX_ROUTES.apply}>Apply to issue</Button>
 *   </ButtonRow>
 * </PageHeader>
 * ```
 */
export function PageHeader({
  eyebrow,
  title,
  lede,
  children,
  variant = "light",
  className,
}: {
  eyebrow?: ReactNode;
  title: ReactNode;
  lede?: ReactNode;
  children?: ReactNode;
  variant?: "light" | "dark";
  className?: string;
}) {
  return (
    <Section first variant={variant} className={className}>
      {eyebrow ? <Eyebrow className="mb-3.5">{eyebrow}</Eyebrow> : null}
      <h1 className="mx-h1 max-w-[15em]">{title}</h1>
      {lede ? <Lede className="mt-6">{lede}</Lede> : null}
      {children}
    </Section>
  );
}

/**
 * Heading block inside a Section: optional eyebrow, an h2, and optional
 * intro copy. Saves every page from re-spelling the same three margins.
 */
export function SectionHead({
  eyebrow,
  title,
  intro,
  className,
}: {
  eyebrow?: ReactNode;
  title: ReactNode;
  intro?: ReactNode;
  className?: string;
}) {
  return (
    <div className={className}>
      {eyebrow ? <Eyebrow className="mb-3.5">{eyebrow}</Eyebrow> : null}
      <H2>{title}</H2>
      {intro ? <Body className="mt-4">{intro}</Body> : null}
    </div>
  );
}
