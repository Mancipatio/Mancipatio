import type { ReactNode } from "react";

export function SectionHeader({
  eyebrow,
  title,
  lead,
  align = "left",
}: {
  eyebrow?: string;
  title: ReactNode;
  lead?: ReactNode;
  align?: "left" | "center";
}) {
  const aligns = align === "center" ? "text-center mx-auto" : "text-left";
  return (
    <header className={`max-w-3xl ${aligns}`}>
      {eyebrow && <p className="page-eyebrow">{eyebrow}</p>}
      <h2 className="mt-2 text-display-2 text-slate-900">{title}</h2>
      {lead && <p className="mt-3 text-lead">{lead}</p>}
    </header>
  );
}
