"use client";
import type { WalletSession } from "@solana/client";
import { createSignedRequest, signedFetch } from "@/lib/siws-client";
import {
  canonicalDistributionPlan,
  type DistributionPlanContext,
  type DistributionPlanEntry,
  type PreparedDistributionPlan,
} from "@/lib/distribution-plans";
export async function prepareDistributionPlan(
  session: WalletSession | null | undefined,
  context: DistributionPlanContext,
  entries: DistributionPlanEntry[],
): Promise<PreparedDistributionPlan> {
  const plan = await canonicalDistributionPlan(context, entries),
    payload = await createSignedRequest(session, "distribution-plans.prepare", {
      ...context,
      root_hex: plan.root_hex,
      plan_hash: plan.plan_hash,
      batch_count: plan.batch_count,
    });
  const response = await fetch("/api/distribution-plans/prepare", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    cache: "no-store",
    body: JSON.stringify({
      ...payload,
      plan_entries: plan.batches.flatMap((batch) => batch.entries),
    }),
  });
  const result = await response.json();
  if (!response.ok || result?.ok !== true)
    throw new Error(result?.error ?? "Distribution plan preparation failed");
  return result.data as PreparedDistributionPlan;
}
export function bindDistributionPlan(
  session: WalletSession | null | undefined,
  plan_id: string,
) {
  return signedFetch<PreparedDistributionPlan>(
    session,
    "/api/distribution-plans/bind",
    "distribution-plans.bind",
    { plan_id },
  );
}
export type DistributionPlanSummary = Omit<PreparedDistributionPlan, "batches">;
export function listDistributionPlans(
  session: WalletSession | null | undefined,
  distribution_pda?: string,
  cursor?: string,
) {
  return signedFetch<{
    plans: DistributionPlanSummary[];
    next_cursor: string | null;
  }>(
    session,
    "/api/distribution-plans/admin-read",
    "distribution-plans.adminRead",
    {
      ...(distribution_pda ? { distribution_pda } : {}),
      ...(cursor ? { cursor } : {}),
    },
  );
}
export function readDistributionPlan(
  session: WalletSession | null | undefined,
  plan_id: string,
) {
  return signedFetch<PreparedDistributionPlan>(
    session,
    "/api/distribution-plans/admin-read",
    "distribution-plans.adminRead",
    { plan_id },
  );
}
