"use client";
import type { WalletSession } from "@solana/client";
import type { AuditCategory, AuditStatus } from "@/lib/supabase";
import { signedFetch } from "@/lib/siws-client";
export type PrivateAuditRow = {
  id: string; created_at: string; ix_name: string; category: AuditCategory;
  actor_wallet: string | null; target_label: string | null; tx_signature: string | null;
  reason: string | null; status: AuditStatus; metadata: Record<string, unknown> | null;
};
export async function listAuditEvents(session: WalletSession | null | undefined, page = 0): Promise<PrivateAuditRow[]> {
  return signedFetch(session, "/api/audit/list", "audit.list", { page });
}
