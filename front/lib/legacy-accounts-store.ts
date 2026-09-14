"use client";
import type { LegacyPayoutVault, LegacyShareClass } from "@/lib/legacy-accounts";
type Snapshot = { network: string | null; shareClasses: LegacyShareClass[]; payoutVaults: { address: string; vault: LegacyPayoutVault }[] };
const initial: Snapshot = { network: null, shareClasses: [], payoutVaults: [] };
let snapshot = initial;
const listeners = new Set<() => void>();
const encoded = (value: unknown) => JSON.stringify(value, (_, v) => typeof v === "bigint" ? v.toString() : v);
function publish(network: string, patch: Partial<Omit<Snapshot, "network">>) {
  if (typeof window === "undefined") return;
  const next = { ...(snapshot.network === network ? snapshot : initial), network, ...patch };
  if (encoded(snapshot) === encoded(next)) return;
  snapshot = next; listeners.forEach((listener) => listener());
}
export const publishLegacyShareClasses = (network: string, shareClasses: LegacyShareClass[]) => publish(network, { shareClasses });
export const publishLegacyPayoutVaults = (network: string, payoutVaults: Snapshot["payoutVaults"]) => publish(network, { payoutVaults });
export const getLegacySnapshot = () => snapshot;
export const getLegacyServerSnapshot = () => initial;
export function subscribeLegacy(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
