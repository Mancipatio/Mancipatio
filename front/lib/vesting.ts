"use client";

// Vesting schedule persistence + Merkle helpers.

import { type Address } from "@solana/kit";
import type { WalletSession } from "@solana/client";
import { merkleProof, merkleRoot, snapshotLeaf } from "@/lib/merkle";
import { signedFetch } from "@/lib/siws-client";

export type VestingCurve = "cliff" | "linear" | "step" | "custom";

export type VestingStatus =
  | "draft"
  | "beneficiaries_set"
  | "merkle_built"
  | "published"
  | "live"
  | "completed"
  | "cancelled";

export type VestingSchedule = {
  id: string;
  created_at: string;
  updated_at: string;
  asset_mint: string;
  asset_label: string;
  rights_token: string | null;
  title: string;
  description: string;
  curve: VestingCurve;
  total_amount: string;             // numeric → string from PostgREST
  start_date: string | null;
  duration_months: number | null;
  step_count: number | null;
  step_interval_months: number | null;
  cliff_date: string | null;
  curve_config: Record<string, unknown>;
  merkle_root: string | null;
  merkle_built_at: string | null;
  status: VestingStatus;
  notes: string;
  author: string;
};

export type VestingMilestone = {
  schedule_id: string;
  idx: number;
  unlock_date: string;
  amount: string;
  published: boolean;
  published_at: string | null;
  published_tx: string | null;
};

export type VestingBeneficiary = {
  schedule_id: string;
  wallet: string;
  entitlement: string;
  merkle_index: number;
  merkle_proof: string[];
};

export type VestingClaim = {
  schedule_id: string;
  milestone_idx: number;
  wallet: string;
  amount: string;
  claimed_at: string;
  claimed_tx: string | null;
};

export type CurveInput = {
  curve: VestingCurve;
  totalAmount: bigint;
  startDate: string;        // ISO yyyy-mm-dd
  durationMonths?: number;
  stepCount?: number;
  stepIntervalMonths?: number;
  cliffDate?: string;
  customRows?: { date: string; amount: bigint }[];
};

export type ComputedMilestone = {
  idx: number;
  unlock_date: string;
  amount: bigint;
};

function addMonths(iso: string, months: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  const target = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, d.getUTCDate()),
  );
  return target.toISOString().slice(0, 10);
}

export function computeSchedule(input: CurveInput): ComputedMilestone[] {
  const total = input.totalAmount;
  if (input.curve === "cliff") {
    return [
      {
        idx: 0,
        unlock_date: input.cliffDate ?? input.startDate,
        amount: total,
      },
    ];
  }
  if (input.curve === "linear") {
    const months = Math.max(1, input.durationMonths ?? 12);
    const per = total / BigInt(months);
    const remainder = total - per * BigInt(months);
    return Array.from({ length: months }, (_, i) => ({
      idx: i,
      unlock_date: addMonths(input.startDate, i + 1),
      amount: i === months - 1 ? per + remainder : per,
    }));
  }
  if (input.curve === "step") {
    const n = Math.max(1, input.stepCount ?? 4);
    const interval = Math.max(1, input.stepIntervalMonths ?? 3);
    const per = total / BigInt(n);
    const remainder = total - per * BigInt(n);
    return Array.from({ length: n }, (_, i) => ({
      idx: i,
      unlock_date: addMonths(input.startDate, (i + 1) * interval),
      amount: i === n - 1 ? per + remainder : per,
    }));
  }
  // custom
  const rows = (input.customRows ?? [])
    .slice()
    .sort((a, b) => a.date.localeCompare(b.date));
  return rows.map((r, i) => ({
    idx: i,
    unlock_date: r.date,
    amount: r.amount,
  }));
}

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 1) {
    out += bytes[i].toString(16).padStart(2, "0");
  }
  return out;
}

export type BuiltVestingMerkle = {
  rootHex: string;
  perWallet: Array<{
    wallet: string;
    entitlement: bigint;
    index: number;
    proofHex: string[];
  }>;
};

/**
 * Build a single Merkle tree over (wallet, entitlement) pairs. Same
 * sorted-pair SHA-256 shape as `lib/merkle.ts` so the on-chain verifier
 * accepts the proof unchanged.
 */
export async function buildVestingMerkle(
  beneficiaries: Array<{ wallet: string; entitlement: bigint }>,
): Promise<BuiltVestingMerkle> {
  const sorted = [...beneficiaries].sort((a, b) =>
    a.wallet < b.wallet ? -1 : a.wallet > b.wallet ? 1 : 0,
  );
  const leaves = await Promise.all(
    sorted.map((b) => snapshotLeaf(b.wallet as Address, b.entitlement)),
  );
  const root = await merkleRoot(leaves);
  const perWallet = await Promise.all(
    sorted.map(async (b, i) => ({
      wallet: b.wallet,
      entitlement: b.entitlement,
      index: i,
      proofHex: (await merkleProof(leaves, i)).map(toHex),
    })),
  );
  return { rootHex: toHex(root), perWallet };
}

// ---------------------------------------------------------------------------
// Signed write helpers — all persistence goes through the /api/vesting/*
// signed routes (service role on the server; anon client is read-only).
// The connected WalletSession (useWalletConnection().wallet) is always the
// FIRST parameter. All three throw an Error with the server message on
// failure — call sites catch and toast.
// ---------------------------------------------------------------------------

export type SaveVestingScheduleInput = {
  assetMint: string;
  assetLabel: string;
  title: string;
  description: string;
  curve: VestingCurve;
  totalAmount: bigint;
  startDate: string | null;
  durationMonths: number | null;
  stepCount: number | null;
  stepIntervalMonths: number | null;
  cliffDate: string | null;
  /** 64-char hex snapshot root; null when no beneficiaries yet. */
  merkleRootHex: string | null;
  milestones: Array<{ idx: number; unlockDate: string; amount: bigint }>;
  beneficiaries: Array<{
    wallet: string;
    entitlement: bigint;
    merkleIndex: number;
    merkleProofHex: string[];
  }>;
};

/**
 * Persist a schedule + milestones + beneficiaries via the admin-only signed
 * route POST /api/vesting/create. `author` and `status` are stamped
 * server-side. Returns the new schedule id.
 */
export async function saveVestingSchedule(
  session: WalletSession | null | undefined,
  input: SaveVestingScheduleInput,
): Promise<string> {
  const data = await signedFetch<{ schedule_id: string }>(
    session,
    "/api/vesting/create",
    "vesting.create",
    {
      schedule: {
        asset_mint: input.assetMint,
        asset_label: input.assetLabel,
        title: input.title,
        description: input.description,
        curve: input.curve,
        total_amount: input.totalAmount.toString(),
        start_date: input.startDate,
        duration_months: input.durationMonths,
        step_count: input.stepCount,
        step_interval_months: input.stepIntervalMonths,
        cliff_date: input.cliffDate,
        merkle_root: input.merkleRootHex,
      },
      milestones: input.milestones.map((m) => ({
        idx: m.idx,
        unlock_date: m.unlockDate,
        amount: m.amount.toString(),
      })),
      beneficiaries: input.beneficiaries.map((b) => ({
        wallet: b.wallet,
        entitlement: b.entitlement.toString(),
        merkle_index: b.merkleIndex,
        merkle_proof: b.merkleProofHex,
      })),
    },
  );
  return data.schedule_id;
}

/**
 * Flip a schedule's off-chain status via POST /api/vesting/update-status.
 * Server circle: platform admin OR schedule author OR the asset's on-chain
 * issuer authority.
 */
export async function updateVestingScheduleStatus(
  session: WalletSession | null | undefined,
  scheduleId: string,
  status: VestingStatus,
): Promise<void> {
  await signedFetch(session, "/api/vesting/update-status", "vesting.update-status", {
    schedule_id: scheduleId,
    status,
  });
}

/**
 * Mark one milestone as published on-chain via
 * POST /api/vesting/publish-milestone. Same authz circle as
 * updateVestingScheduleStatus.
 */
export async function markVestingMilestonePublished(
  session: WalletSession | null | undefined,
  scheduleId: string,
  idx: number,
  publishedTx?: string,
): Promise<void> {
  await signedFetch(
    session,
    "/api/vesting/publish-milestone",
    "vesting.publish-milestone",
    {
      schedule_id: scheduleId,
      idx,
      ...(publishedTx ? { published_tx: publishedTx } : {}),
    },
  );
}

/** Returns how many vested units are available at `now` across the schedule. */
export function vestedUpTo(
  milestones: ComputedMilestone[] | VestingMilestone[],
  now: Date = new Date(),
): bigint {
  let acc = BigInt(0);
  const isoNow = now.toISOString().slice(0, 10);
  for (const m of milestones) {
    const date = "unlock_date" in m ? m.unlock_date : (m as ComputedMilestone).unlock_date;
    const amt = typeof m.amount === "string" ? BigInt(m.amount) : m.amount;
    if (date <= isoNow) acc += amt;
  }
  return acc;
}

/** Private beneficiary proof reader; the server returns all rows only to editors. */
export async function readVestingBeneficiaries(session: WalletSession | null | undefined, scheduleId: string): Promise<{ beneficiaries: VestingBeneficiary[]; can_manage: boolean }> {
  const beneficiaries: VestingBeneficiary[] = [];
  for (let offset = 0; ; offset += 100) {
    const page = await signedFetch<{ beneficiaries: VestingBeneficiary[]; can_manage: boolean }>(session, "/api/vesting/beneficiaries", "vesting.beneficiaries", { schedule_id: scheduleId, offset });
    beneficiaries.push(...page.beneficiaries);
    if (page.beneficiaries.length < 100) return { beneficiaries, can_manage: page.can_manage };
  }
}
