import type { ReactNode } from "react";

export type KpiTone = "default" | "quiet" | "good" | "warn" | "bad";

export function Kpi({
  label,
  value,
  sub,
  icon,
  tone = "default",
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  icon?: ReactNode;
  tone?: KpiTone;
}) {
  const toneCls =
    tone === "good"
      ? "kpi-good"
      : tone === "warn"
        ? "kpi-warn"
        : tone === "bad"
          ? "kpi-bad"
          : tone === "quiet"
            ? "kpi-quiet"
            : "";
  return (
    <div className={`kpi ${toneCls}`}>
      <p className="kpi-label">{label}</p>
      <p className="kpi-value">{value}</p>
      {sub && <p className="kpi-sub">{sub}</p>}
      {icon && <span className="kpi-icon">{icon}</span>}
    </div>
  );
}
