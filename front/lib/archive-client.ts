"use client";

// Browser side of the archive (lib/archive.ts): the archived set every list
// hides (public GET, fails OPEN — a list that cannot read it shows
// everything rather than nothing, since hiding is a convenience, never a
// security boundary), and the signed check / set calls of the dialog.

import { useEffect, useState } from "react";
import type { WalletSession } from "@solana/client";
import { signedFetch } from "@/lib/siws-client";
import {
  EMPTY_ARCHIVED,
  archivedSetFrom,
  hideArchived,
  type ArchiveBlocker,
  type ArchiveKind,
  type ArchiveRecord,
  type ArchivedSet,
} from "@/lib/archive";
import type { NetworkData } from "@/lib/enumerate";

let cache: { at: number; value: Promise<ArchivedSet> } | null = null;
const CACHE_MS = 15_000;
const listeners = new Set<() => void>();

/** The archived asset/issuer PDAs (cached 15 s; `fresh` skips the cache). Never throws. */
export function fetchArchivedSet(opts: { fresh?: boolean } = {}): Promise<ArchivedSet> {
  if (!opts.fresh && cache && Date.now() - cache.at < CACHE_MS) return cache.value;
  const value = (async () => {
    try {
      const response = await fetch("/api/archive/list", { cache: "no-store" });
      const body = await response.json();
      if (!response.ok || !body.ok) throw new Error(body.error ?? "Archived list unavailable");
      return archivedSetFrom(body.data);
    } catch (err) {
      console.warn("[archive] archived list unavailable, showing everything:", err instanceof Error ? err.message : err);
      cache = null;
      return EMPTY_ARCHIVED;
    }
  })();
  cache = { at: Date.now(), value };
  return value;
}

/** Forget the cached set (after an archive / unarchive) and tell the mounted lists. */
export function invalidateArchivedSet(): void {
  cache = null;
  for (const listener of listeners) listener();
}

/** The archived set for a component; refreshes after invalidateArchivedSet(). */
export function useArchivedSet(): ArchivedSet | null {
  const [set, setSet] = useState<ArchivedSet | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const listener = () => setTick((t) => t + 1);
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }, []);
  useEffect(() => {
    let cancelled = false;
    void fetchArchivedSet().then((value) => { if (!cancelled) setSet(value); });
    return () => { cancelled = true; };
  }, [tick]);
  return set;
}

/** NetworkData for a public list: archived issuers and assets left out. */
export async function withoutArchived(data: NetworkData): Promise<NetworkData> {
  return hideArchived(data, await fetchArchivedSet());
}

/** NetworkData for the issuer workspace: archived assets left out (an archived issuer still sees itself). */
export async function withoutArchivedAssets(data: NetworkData): Promise<NetworkData> {
  return hideArchived(data, await fetchArchivedSet(), { issuers: false });
}

export type ArchiveClassView = {
  address: string;
  classIndex: number;
  circulating: string;
  lifetimeMinted: string;
  supplyLocked: boolean;
};

export type ArchiveCheck = {
  kind: ArchiveKind;
  pda: string;
  actor: "super" | "issuer" | "admin";
  available: boolean;
  record: ArchiveRecord | null;
  archived: boolean;
  blockers: ArchiveBlocker[];
  refusal: string | null;
  canArchive: boolean;
  canUnarchive: boolean;
  unarchiveRefusal?: string | null;
  // asset only
  name?: string;
  assetId?: string;
  issuer?: string;
  draft?: boolean;
  openSales?: number;
  liveApprovals?: number;
  classes?: ArchiveClassView[];
  lockableAtZero?: ArchiveClassView[];
};

/** What archiving would meet, read fresh (a session read: no prompt once signed in). */
export function checkArchive(session: WalletSession | null | undefined, kind: ArchiveKind, pda: string): Promise<ArchiveCheck> {
  return signedFetch<ArchiveCheck>(session, "/api/archive/check", "archive.check", { kind, pda });
}

/** Archive or unarchive (one signature). `confirm` = the super admin's explicit override of the blockers. */
export async function setArchived(
  session: WalletSession | null | undefined,
  input: { kind: ArchiveKind; pda: string; archive: boolean; reason: string; confirm?: boolean },
): Promise<void> {
  await signedFetch(session, "/api/archive/set", "archive.set", input);
  invalidateArchivedSet();
}
