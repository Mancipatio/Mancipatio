import { AdminNavGroups } from "./admin-nav-groups";
import { ADMIN_MENU } from "./admin-menu";
import { AppShell } from "@/components/app-shell";
import { AdminNavigation } from "@/components/admin-navigation";
import { AdminGate } from "@/components/admin-gate";
import { AdminBadgesProvider } from "@/components/admin-badges";

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return (
    <AppShell section="admin">
      <AdminGate>
        <div className="app-admin-layout">
          {/* The count of what waits for this wallet, per item (lib/admin-badges.ts). */}
          <AdminBadgesProvider>
            <AdminNavigation>
              <AdminNavGroups groups={ADMIN_MENU} />
            </AdminNavigation>
          </AdminBadgesProvider>
          <div className="app-admin-content">{children}</div>
        </div>
      </AdminGate>
    </AppShell>
  );
}
