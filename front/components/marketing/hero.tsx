import type { ReactNode } from "react";
import { MeshBackdrop } from "./mesh-backdrop";
import { StatStrip, type StatItem } from "./stat-strip";

export type HeroProps = {
  variant?: "bold" | "editorial";
  eyebrow?: string;
  title: ReactNode;
  lead?: ReactNode;
  ctas?: ReactNode;
  stats?: StatItem[];
};

export function Hero({
  variant = "bold",
  eyebrow,
  title,
  lead,
  ctas,
  stats,
}: HeroProps) {
  if (variant === "editorial") {
    return (
      <section className="relative">
        <div className="mx-auto max-w-6xl px-5 py-16 sm:py-20">
          {eyebrow && (
            <p className="text-mono-eyebrow text-slate-500">{eyebrow}</p>
          )}
          <h1 className="mt-3 text-display-2 text-slate-900">{title}</h1>
          {lead && <p className="mt-4 max-w-2xl text-lead">{lead}</p>}
          {ctas && <div className="mt-6 flex flex-wrap gap-3">{ctas}</div>}
          {stats && (
            <div className="mt-10">
              <StatStrip items={stats} />
            </div>
          )}
        </div>
      </section>
    );
  }
  return (
    <section className="relative isolate overflow-hidden">
      <MeshBackdrop tone="bright" />
      <div className="relative mx-auto max-w-6xl px-5 py-20 sm:py-28">
        {eyebrow && (
          <p className="text-mono-eyebrow text-slate-500">{eyebrow}</p>
        )}
        <h1 className="mt-4 text-display-1 text-slate-900">{title}</h1>
        {lead && <p className="mt-6 max-w-2xl text-lead">{lead}</p>}
        {ctas && <div className="mt-8 flex flex-wrap gap-3">{ctas}</div>}
        {stats && (
          <div className="mt-12">
            <StatStrip items={stats} />
          </div>
        )}
      </div>
    </section>
  );
}
