import type { ReactNode } from "react";
import {
  IconActivity,
  IconBell,
  IconBox,
  IconBuilding,
  IconChart,
  IconCheck,
  IconClipboard,
  IconCoins,
  IconFile,
  IconGavel,
  IconGlobe,
  IconHome,
  IconKey,
  IconLayers,
  IconLock,
  IconPlug,
  IconRepeat,
  IconRocket,
  IconScale,
  IconSettings,
  IconShield,
  IconStar,
  IconUsers,
  IconWallet,
  IconWarning,
} from "@/components/icons";
import { AdminNav } from "./admin-nav";
import { AppShell } from "@/components/app-shell";
import { AdminNavigation } from "@/components/admin-navigation";
import { RequireRole } from "@/components/require-role";

const GROUPS: Array<{
  label: string | null;
  items: { href: string; label: string; icon: ReactNode }[];
}> = [
  {
    label: null,
    items: [{ href: "/admin", label: "Overview", icon: <IconHome /> }],
  },
  {
    label: "Oversight",
    items: [
      { href: "/admin/dashboards", label: "Dashboards", icon: <IconChart /> },
      { href: "/admin/health", label: "Health", icon: <IconActivity /> },
      { href: "/admin/reports", label: "Reports", icon: <IconFile /> },
      { href: "/admin/audit", label: "Audit log", icon: <IconClipboard /> },
    ],
  },
  {
    label: "On-chain",
    items: [
      { href: "/admin/issuers", label: "Issuers", icon: <IconBuilding /> },
      { href: "/admin/spvs", label: "SPVs", icon: <IconScale /> },
      { href: "/admin/applications", label: "Applications", icon: <IconClipboard /> },
      { href: "/admin/limits", label: "Raise limits", icon: <IconScale /> },
      { href: "/admin/assets", label: "Assets", icon: <IconBox /> },
      { href: "/admin/share-classes", label: "Share classes", icon: <IconLayers /> },
      { href: "/admin/launchpad", label: "Launchpad", icon: <IconRocket /> },
      { href: "/admin/custody", label: "Custody", icon: <IconLock /> },
      { href: "/admin/otc", label: "OTC", icon: <IconRepeat /> },
      { href: "/admin/resell", label: "Resell board", icon: <IconRepeat /> },
      { href: "/admin/governance", label: "Governance", icon: <IconScale /> },
      { href: "/admin/rights", label: "Rights Token", icon: <IconStar /> },
      { href: "/admin/vesting", label: "Vesting series", icon: <IconLock /> },
    ],
  },
  {
    label: "People",
    items: [
      { href: "/admin/clients", label: "Clients", icon: <IconUsers /> },
      { href: "/admin/inquiries", label: "Inquiries", icon: <IconFile /> },
      { href: "/admin/kyc", label: "KYC", icon: <IconCheck /> },
      { href: "/admin/compliance", label: "Compliance", icon: <IconShield /> },
      { href: "/admin/blocklist", label: "Blocklist", icon: <IconWarning /> },
      { href: "/admin/admins", label: "Admins", icon: <IconKey /> },
    ],
  },
  {
    label: "Money",
    items: [
      { href: "/admin/fees", label: "Fees", icon: <IconCoins /> },
      { href: "/admin/payouts", label: "Payouts", icon: <IconWallet /> },
    ],
  },
  {
    label: "System",
    items: [
      { href: "/admin/platform", label: "Platform", icon: <IconSettings /> },
      { href: "/admin/jurisdictions", label: "Jurisdictions", icon: <IconGlobe /> },
      { href: "/admin/documents", label: "Documents", icon: <IconFile /> },
      { href: "/admin/notifications", label: "Notifications", icon: <IconBell /> },
      { href: "/admin/integrations", label: "Integrations", icon: <IconPlug /> },
      { href: "/admin/services", label: "Services", icon: <IconGavel /> },
    ],
  },
];

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return (
    <AppShell section="admin">
      <RequireRole role="admin">
        <div className="app-admin-layout">
          <AdminNavigation>
            {GROUPS.map((group, index) => (
              <div key={group.label ?? `group-${index}`} className="app-admin-nav-group">
                {group.label && <p>{group.label}</p>}
                <AdminNav items={group.items} />
              </div>
            ))}
          </AdminNavigation>
          <div className="app-admin-content">{children}</div>
        </div>
      </RequireRole>
    </AppShell>
  );
}
