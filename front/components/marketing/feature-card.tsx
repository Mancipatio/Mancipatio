import Link from "next/link";
import type { ReactNode } from "react";
import { IconArrowUpRight } from "@/components/icons";

export type FeatureCardProps = {
  icon?: ReactNode;
  eyebrow?: string;
  title: string;
  body: ReactNode;
  href?: string;
  ctaLabel?: string;
  secondaryHref?: string;
  secondaryLabel?: string;
};

export function FeatureCard({
  icon,
  eyebrow,
  title,
  body,
  href,
  ctaLabel,
  secondaryHref,
  secondaryLabel,
}: FeatureCardProps) {
  const header = (icon || eyebrow) && (
    <div className="flex items-start justify-between">
      {icon ? (
        <span className="grid h-9 w-9 place-items-center rounded-md bg-brand-50 text-brand-700 transition-colors group-hover:bg-brand-600 group-hover:text-white">
          {icon}
        </span>
      ) : (
        <span />
      )}
      {eyebrow && <span className="page-eyebrow">{eyebrow}</span>}
    </div>
  );

  const content = (
    <>
      <h3 className="mt-4 text-[16px] font-semibold text-slate-900">{title}</h3>
      <div className="mt-1.5 text-[13.5px] leading-relaxed text-slate-600">
        {body}
      </div>
    </>
  );

  const className =
    "group panel panel-pad block transition-all hover:-translate-y-0.5 hover:border-brand-200 hover:shadow-card-brand";

  // When a secondary CTA is requested, render the card as a plain container with
  // explicit links in a footer row. Nesting <a> elements is invalid HTML, so the
  // whole-card anchor pattern cannot be used here.
  if (secondaryHref) {
    return (
      <div className={`${className} flex flex-col`}>
        {header}
        {content}
        <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 pt-1">
          {href && (
            <Link
              href={href}
              className="inline-flex items-center gap-1 text-[12.5px] font-medium text-brand-700 transition-colors hover:text-brand-800"
            >
              {ctaLabel ?? "Learn more"}
              <IconArrowUpRight size={14} />
            </Link>
          )}
          <Link
            href={secondaryHref}
            className="inline-flex items-center gap-1 text-[12.5px] font-medium text-slate-500 transition-colors hover:text-slate-700"
          >
            {secondaryLabel ?? "Details"}
            <IconArrowUpRight size={14} />
          </Link>
        </div>
      </div>
    );
  }

  const inner = (
    <>
      {header}
      {content}
      {href && (
        <span className="mt-4 inline-flex items-center gap-1 text-[12.5px] font-medium text-brand-700 transition-colors group-hover:text-brand-800">
          {ctaLabel ?? "Learn more"}
          <IconArrowUpRight size={14} />
        </span>
      )}
    </>
  );

  return href ? (
    <Link href={href} className={className}>
      {inner}
    </Link>
  ) : (
    <div className={className}>{inner}</div>
  );
}
