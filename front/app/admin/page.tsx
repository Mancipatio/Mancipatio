import Link from "next/link";
import { AlertsCard } from "@/components/alerts-card";
import {
  IconArrowUpRight,
  IconBox,
  IconBuilding,
  IconChart,
  IconLayers,
  IconLock,
  IconRepeat,
  IconRocket,
  IconScale,
  IconStar,
} from "@/components/icons";
import { PlatformStatusCard } from "@/components/platform-status-card";
import { RequireRole } from "@/components/require-role";
import { NetworkDashboard } from "./network-dashboard";

const SHORTCUTS = [
  {
    href: "/admin/issuers",
    title: "Issuers",
    body: "Register legal entities and verify their KYB.",
    icon: <IconBuilding />,
  },
  {
    href: "/admin/assets",
    title: "Assets",
    body: "Create tokenized assets under verified issuers.",
    icon: <IconBox />,
  },
  {
    href: "/admin/share-classes",
    title: "Share classes",
    body: "Define share classes and deploy their Token-2022 mints.",
    icon: <IconLayers />,
  },
  {
    href: "/admin/launchpad",
    title: "Launchpad",
    body: "Open and run primary sales of share-class units.",
    icon: <IconRocket />,
  },
  {
    href: "/admin/custody",
    title: "Custody",
    body: "Escrow units in program-owned vaults and run their lifecycle.",
    icon: <IconLock />,
  },
  {
    href: "/admin/otc",
    title: "OTC",
    body: "Post, fund, fill and cancel secondary-market offers.",
    icon: <IconRepeat />,
  },
  {
    href: "/admin/governance",
    title: "Governance",
    body: "Open proposals and run snapshot-weighted advisory votes.",
    icon: <IconScale />,
  },
  {
    href: "/admin/rights",
    title: "Rights Token",
    body: "Open vesting issuances and process milestone claims.",
    icon: <IconStar />,
  },
  {
    href: "/admin/dashboards",
    title: "Network dashboards",
    body: "Live on-chain figures and entity directories.",
    icon: <IconChart />,
  },
];

export default function AdminOverview() {
  return (
    <section className="min-w-0 flex-1">
      <div>
        <p className="page-eyebrow">Command center</p>
        <h1 className="page-title">Platform overview</h1>
        <p className="page-sub">
          Live state of the Mancipatio tokenization platform — health, KPIs,
          alerts and operational shortcuts.
        </p>
      </div>

      <RequireRole role="admin" allowBootstrap>
        <div className="mt-6 grid gap-4 lg:grid-cols-2">
          <PlatformStatusCard />
          <AlertsCard />
        </div>

        <section className="mt-8">
          <h2 className="page-eyebrow">Key figures</h2>
          <div className="mt-3">
            <NetworkDashboard />
          </div>
        </section>

        <section className="mt-8">
          <div className="flex items-baseline justify-between">
            <h2 className="page-eyebrow">Operations</h2>
            <Link
              href="/admin/services"
              className="text-[11px] text-slate-500 underline-offset-2 hover:underline"
            >
              All services →
            </Link>
          </div>
          <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {SHORTCUTS.map((c) => (
              <Link
                key={c.href}
                href={c.href}
                className="group panel panel-pad relative transition-all hover:-translate-y-0.5 hover:border-brand-200 hover:shadow-card-brand"
              >
                <div className="flex items-start justify-between">
                  <span className="grid h-8 w-8 place-items-center rounded-md bg-brand-50 text-brand-700 transition-colors group-hover:bg-brand-600 group-hover:text-white">
                    {c.icon}
                  </span>
                  <span className="text-slate-300 transition-colors group-hover:text-brand-600">
                    <IconArrowUpRight />
                  </span>
                </div>
                <h3 className="mt-3 text-[14px] font-semibold text-slate-900">
                  {c.title}
                </h3>
                <p className="mt-1 text-[12.5px] leading-relaxed text-slate-600">
                  {c.body}
                </p>
              </Link>
            ))}
          </div>
        </section>
      </RequireRole>
    </section>
  );
}
