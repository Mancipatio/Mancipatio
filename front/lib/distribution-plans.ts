import {
  address,
  getAddressEncoder,
  getProgramDerivedAddress,
  type Address,
} from "@solana/kit";
import { findAssociatedTokenPda } from "@solana-program/token-2022";
import {
  ASSET_REGISTRY_PROGRAM_ADDRESS,
  findDistributionPda,
} from "@/lib/generated/asset_registry";
import { merkleRoot } from "@/lib/merkle";
import type { Network } from "@/lib/network";
export const DISTRIBUTION_PLAN_BATCH_SIZE = 6;
export const DISTRIBUTION_PLAN_MAX_ENTRIES = 5000;
const U64_MAX = (BigInt(1) << BigInt(64)) - BigInt(1);
const TOKEN_CLASSIC = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
export type DistributionPlanContext = {
  distribution_pda: string;
  distribution_id: string;
  share_class: string;
  payment_mint: string;
  payment_token_program: string;
  funder: string;
  total_amount: string;
  snapshot_supply: string;
};
export type DistributionPlanEntry = {
  token_account: string;
  token_owner: string;
  amount: string;
};
export type DistributionPlanBatch = {
  batch_id: number;
  entries: DistributionPlanEntry[];
  leaf_hex: string;
  proof: string[];
};
export type CanonicalDistributionPlan = DistributionPlanContext & {
  root_hex: string;
  plan_hash: string;
  batch_count: number;
  batches: DistributionPlanBatch[];
  allocated_amount: string;
  entry_count: number;
};
export type PreparedDistributionPlan = CanonicalDistributionPlan & {
  id: string;
  network: Network;
  status: "prepared" | "bound";
  bound_slot: string | null;
};
export const distributionPlanHex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
export function distributionPlanBytes(value: string) {
  if (!/^[a-f0-9]{64}$/.test(value))
    throw new Error("Expected a 32-byte lowercase hash");
  return Uint8Array.from(value.match(/../g)!, (part) => parseInt(part, 16));
}
async function hash(bytes: Uint8Array) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.slice()));
}
function u64(value: string, allowZero = false) {
  if (
    typeof value !== "string" ||
    !/^(0|[1-9]\d*)$/.test(value) ||
    BigInt(value) > U64_MAX ||
    (!allowZero && BigInt(value) === BigInt(0))
  )
    throw new Error(
      "Distribution amounts and identifiers must be canonical u64 integers",
    );
  return BigInt(value);
}
export async function distributionBatchLeaf(
  distribution: Address,
  batchId: number,
  entries: readonly DistributionPlanEntry[],
) {
  if (
    !Number.isInteger(batchId) ||
    batchId < 0 ||
    batchId > 0xffffffff ||
    !entries.length
  )
    throw new Error("Invalid distribution batch");
  const domain = new TextEncoder().encode("mancipatio:distribution-batch:v1"),
    bytes = new Uint8Array(domain.length + 32 + 4 + 4 + entries.length * 72),
    view = new DataView(bytes.buffer),
    encoder = getAddressEncoder();
  let offset = 0;
  bytes.set(domain, offset);
  offset += domain.length;
  bytes.set(encoder.encode(distribution), offset);
  offset += 32;
  view.setUint32(offset, batchId, true);
  offset += 4;
  view.setUint32(offset, entries.length, true);
  offset += 4;
  for (const entry of entries) {
    bytes.set(encoder.encode(address(entry.token_account)), offset);
    offset += 32;
    bytes.set(encoder.encode(address(entry.token_owner)), offset);
    offset += 32;
    view.setBigUint64(offset, u64(entry.amount), true);
    offset += 8;
  }
  return hash(bytes);
}
export async function distributionPlanPda(distribution: Address) {
  return (
    await getProgramDerivedAddress({
      programAddress: ASSET_REGISTRY_PROGRAM_ADDRESS,
      seeds: [
        new TextEncoder().encode("distribution_plan"),
        getAddressEncoder().encode(distribution),
      ],
    })
  )[0];
}
export async function distributionBatchPda(
  distribution: Address,
  batchId: number,
) {
  if (!Number.isInteger(batchId) || batchId < 0 || batchId > 0xffffffff)
    throw new Error("Invalid batch id");
  const id = new Uint8Array(4);
  new DataView(id.buffer).setUint32(0, batchId, true);
  return (
    await getProgramDerivedAddress({
      programAddress: ASSET_REGISTRY_PROGRAM_ADDRESS,
      seeds: [
        new TextEncoder().encode("distribution_batch"),
        getAddressEncoder().encode(distribution),
        id,
      ],
    })
  )[0];
}
/** Canonical immutable recipients, root and context commitment shared by server
 * and browser. Live holder scans are inputs only before funding, never resume. */
export async function canonicalDistributionPlan(
  input: DistributionPlanContext,
  rawEntries: readonly DistributionPlanEntry[],
): Promise<CanonicalDistributionPlan> {
  const context: DistributionPlanContext = {
    distribution_pda: address(input.distribution_pda),
    distribution_id: String(u64(input.distribution_id, true)),
    share_class: address(input.share_class),
    payment_mint: address(input.payment_mint),
    payment_token_program: address(input.payment_token_program),
    funder: address(input.funder),
    total_amount: String(u64(input.total_amount)),
    snapshot_supply: String(u64(input.snapshot_supply)),
  };
  if (![TOKEN_CLASSIC, TOKEN_2022].includes(context.payment_token_program))
    throw new Error("Unsupported payment token program");
  const [expected] = await findDistributionPda({
    shareClass: address(context.share_class),
    distributionId: BigInt(context.distribution_id),
  });
  if (expected !== context.distribution_pda)
    throw new Error(
      "Distribution PDA does not match the prepared id and share class",
    );
  if (
    !Array.isArray(rawEntries) ||
    rawEntries.length < 1 ||
    rawEntries.length > DISTRIBUTION_PLAN_MAX_ENTRIES
  )
    throw new Error(
      `Use 1–${DISTRIBUTION_PLAN_MAX_ENTRIES} distribution recipients`,
    );
  const entries = rawEntries
    .map((e) => ({
      token_account: address(e.token_account),
      token_owner: address(e.token_owner),
      amount: String(u64(e.amount)),
    }))
    .sort((a, b) =>
      a.token_owner < b.token_owner
        ? -1
        : a.token_owner > b.token_owner
          ? 1
          : a.token_account < b.token_account
            ? -1
            : a.token_account > b.token_account
              ? 1
              : 0,
    );
  const owners = new Set<string>(),
    accounts = new Set<string>();
  let allocated = BigInt(0);
  for (const entry of entries) {
    if (owners.has(entry.token_owner) || accounts.has(entry.token_account))
      throw new Error(
        "Distribution recipients must have unique owners and token accounts",
      );
    owners.add(entry.token_owner);
    accounts.add(entry.token_account);
    allocated += BigInt(entry.amount);
  }
  if (allocated !== BigInt(context.total_amount))
    throw new Error(
      "Distribution plan allocation must equal the full funded amount",
    );
  await Promise.all(
    entries.map(async (entry) => {
      const [ata] = await findAssociatedTokenPda({
        owner: address(entry.token_owner),
        mint: address(context.payment_mint),
        tokenProgram: address(context.payment_token_program),
      });
      if (ata !== entry.token_account)
        throw new Error(
          "Distribution recipient account must be the committed owner's payment ATA",
        );
    }),
  );
  const batches: DistributionPlanBatch[] = [];
  for (
    let offset = 0;
    offset < entries.length;
    offset += DISTRIBUTION_PLAN_BATCH_SIZE
  )
    batches.push({
      batch_id: batches.length,
      entries: entries.slice(offset, offset + DISTRIBUTION_PLAN_BATCH_SIZE),
      leaf_hex: "",
      proof: [],
    });
  const leaves = await Promise.all(
    batches.map((batch) =>
      distributionBatchLeaf(
        address(context.distribution_pda),
        batch.batch_id,
        batch.entries,
      ),
    ),
  );
  // Build each level once; recomputing the entire tree per proof is quadratic.
  const levels: Uint8Array[][] = [leaves];
  while (levels[levels.length - 1].length > 1) {
    const level = levels[levels.length - 1];
    const next = await Promise.all(
      Array.from({ length: Math.ceil(level.length / 2) }, (_, pair) => {
        const index = pair * 2;
        return index + 1 < level.length
          ? merkleRoot([level[index], level[index + 1]])
          : Promise.resolve(level[index]);
      }),
    );
    levels.push(next);
  }
  const root = levels[levels.length - 1][0];
  for (let index = 0; index < batches.length; index++) {
    const batch = batches[index];
    batch.leaf_hex = distributionPlanHex(leaves[index]);
    let at = index;
    for (let depth = 0; depth < levels.length - 1; depth++) {
      const sibling = at ^ 1;
      if (sibling < levels[depth].length)
        batch.proof.push(distributionPlanHex(levels[depth][sibling]));
      at = Math.floor(at / 2);
    }
  }
  const plan_hash = distributionPlanHex(
    await hash(
      new TextEncoder().encode(
        JSON.stringify({
          ...context,
          batches: batches.map(({ batch_id, entries }) => ({
            batch_id,
            entries,
          })),
        }),
      ),
    ),
  );
  return {
    ...context,
    root_hex: distributionPlanHex(root),
    plan_hash,
    batch_count: batches.length,
    batches,
    allocated_amount: String(allocated),
    entry_count: entries.length,
  };
}
export async function assertStoredDistributionPlan(
  plan: CanonicalDistributionPlan,
) {
  const canonical = await canonicalDistributionPlan(
    plan,
    plan.batches.flatMap((batch) => batch.entries),
  );
  if (
    canonical.plan_hash !== plan.plan_hash ||
    canonical.root_hex !== plan.root_hex ||
    canonical.batch_count !== plan.batch_count ||
    JSON.stringify(canonical.batches) !== JSON.stringify(plan.batches) ||
    canonical.allocated_amount !== plan.allocated_amount ||
    canonical.entry_count !== plan.entry_count
  )
    throw new Error(
      "The saved distribution plan differs from its immutable commitment",
    );
  return canonical;
}
