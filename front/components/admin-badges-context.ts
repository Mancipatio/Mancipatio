"use client";

// What the admin menu reads from AdminBadgesProvider (components/admin-badges.tsx).
// Its own file so the menu components (and their tests) do not load the
// provider's wallet and role hooks.

import { createContext, useContext } from "react";
import { NO_BADGE_MENU, type BadgeMenu } from "@/lib/admin-badges";

export const AdminBadgesContext = createContext<BadgeMenu>(NO_BADGE_MENU);

/** The menu's pills: `view(href)` per item, `total` for the collapsed toggle. */
export function useAdminBadges(): BadgeMenu {
  return useContext(AdminBadgesContext);
}
