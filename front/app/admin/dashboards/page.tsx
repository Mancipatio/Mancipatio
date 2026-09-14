import { NetworkDashboard } from "../network-dashboard";

export default function DashboardsPage() {
  return (
    <section className="min-w-0 flex-1">
      <h1 className="text-2xl font-semibold">Network dashboards</h1>
      <p className="mt-1.5 text-[13px] leading-relaxed text-slate-600">
        Live on-chain figures — issuers, tokenized assets, tokens released,
        primary and secondary volume, and the vesting plan.
      </p>
      <div className="mt-8">
        <NetworkDashboard full />
      </div>
    </section>
  );
}
