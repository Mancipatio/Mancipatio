import {
  address,
  type Address,
  type GetSignatureStatusesApi,
  type Rpc as KitRpc,
  type Signature,
  type TransactionSigner,
} from "@solana/kit";
import {
  ASSET_REGISTRY_PROGRAM_ADDRESS,
  findAdminRecordPda,
  findPlatformPda,
  fetchMaybePlatform,
  findTransferPda,
  fetchMaybeAuthorityProposal,
  fetchMaybeAdmin,
  getProposeCustodyAuthorityInstructionAsync,
  getAcceptCustodyAuthorityInstructionAsync,
  getCancelCustodyAuthorityTransferInstructionAsync,
  VaultState,
  type CustodyVault,
} from "@/lib/generated/asset_registry";
import { fetchMaybeLiveCustodyVault } from "@/lib/closed-account";
import { findCustodyVaultPda } from "@/lib/pdas";
import { PROPOSAL_NOT_FINALIZED_HINT } from "@/lib/operational-authority";
import type { AuditInput } from "@/lib/supabase";

/**
 * The live vault behind `vaultPda`, read at finalized and identity-checked
 * (owned by the program, its PDA re-derived from its share class and id).
 * A caller that needs both the operator proof and the vault's own data (the
 * realize KYC accounts, the deposit ledger) reads it once through here.
 */
export async function fetchVerifiedCustodyVault(
  rpc: Parameters<typeof fetchMaybeLiveCustodyVault>[0],
  vaultPda: Address,
): Promise<CustodyVault> {
  const vault = await fetchMaybeLiveCustodyVault(rpc, vaultPda, {
    commitment: "finalized",
    abortSignal: AbortSignal.timeout(8_000),
  });
  if (
    !vault.exists ||
    vault.programAddress !== ASSET_REGISTRY_PROGRAM_ADDRESS ||
    (await findCustodyVaultPda(vault.data.shareClass, vault.data.vaultId)) !==
      vaultPda
  )
    throw new Error("Custody vault identity could not be verified");
  return vault.data;
}

/** The AdminRecord PDA of the vault's current operator (see custodyAuthorityRecord). */
export async function custodyAuthorityRecordFor(
  vault: Pick<CustodyVault, "authority">,
): Promise<Address> {
  const [record] = await findAdminRecordPda({ authority: vault.authority });
  return record;
}

/** Bind the proof to the vault's current operator. The PDA may be absent after
 * revocation: permissionless deadline returns must still be constructible. */
export async function custodyAuthorityRecord(
  rpc: Parameters<typeof fetchMaybeLiveCustodyVault>[0],
  vaultPda: Address,
): Promise<Address> {
  return custodyAuthorityRecordFor(await fetchVerifiedCustodyVault(rpc, vaultPda));
}

// ── Custody operator rotation (Talas 3.1 K10) ───────────────────────────────
//
// `accept_custody_authority` requires the vault to be Active or Triggered,
// `transfer.current_authority == vault.authority`, `transfer.proposed_by ==
// platform.admin` and, since v1.0.0-rc, a proposal younger than 14 days
// (`AuthorityProposal.expires_at`, ProposalExpired 6151). A proposal made
// before the vault operator or the Super Admin changed is therefore STALE: it
// can never be accepted; the Super Admin re-proposes (overwriting it) or it is
// cancelled — by the Super Admin, or by the vault's current operator while it
// holds a live Admin record. A stale proposal is reported, not thrown; a
// proposal of the wrong owner or target still throws.

/** Accept (and propose) need the vault in one of these states. */
export function isCustodyRotatable(state: VaultState): boolean {
  return state === VaultState.Active || state === VaultState.Triggered;
}

export const CUSTODY_STALE_PROPOSAL =
  "Proposal is stale — the Super Admin must re-propose";
export const CUSTODY_EXPIRED_PROPOSAL =
  "Proposal expired (14 days) — the Super Admin must re-propose, or cancel it";

/**
 * Why the proposed wallet cannot accept custody responsibility now, or null.
 * Mirrors the `accept_custody_authority` constraints (the acceptor's live
 * Admin record included).
 */
export function custodyAcceptBlocker(p: {
  stale: boolean;
  vaultState: VaultState;
  acceptorIsAdmin: boolean;
  /** Chain time is at or past the proposal's `expires_at` (unknown: false; the program decides). */
  expired?: boolean;
}): string | null {
  if (!isCustodyRotatable(p.vaultState))
    return `The vault is ${VaultState[p.vaultState] ?? "closed"}; custody responsibility can move only while it is Active or Triggered.`;
  if (p.stale) return CUSTODY_STALE_PROPOSAL;
  if (p.expired) return CUSTODY_EXPIRED_PROPOSAL;
  if (!p.acceptorIsAdmin)
    return "This wallet needs an active Admin record before it can accept custody responsibility.";
  return null;
}

type Rpc = Parameters<typeof fetchMaybeLiveCustodyVault>[0];

export type CustodyAuthorityState = {
  vaultPda: Address;
  platformPda: Address;
  transferPda: Address;
  /** The vault's live operator. */
  current: Address;
  superAdmin: Address;
  vaultState: VaultState;
  /** The staged operator, or null. */
  proposed: Address | null;
  proposedBy: Address | null;
  /** When the staged proposal stops being acceptable (unix s), or null. */
  expiresAt: bigint | null;
  /**
   * A proposal exists but accept would fail: the vault operator or the Super
   * Admin changed after it was made. The Super Admin re-proposes.
   */
  stale: boolean;
};

export async function loadCustodyAuthority(
  rpc: Rpc,
  vaultPda: Address,
): Promise<CustodyAuthorityState> {
  const options = {
    commitment: "finalized" as const,
    abortSignal: AbortSignal.timeout(10_000),
  };
  const [platformPda] = await findPlatformPda(),
    [transferPda] = await findTransferPda({ custodyVault: vaultPda });
  const [vault, platform, transfer] = await Promise.all([
    fetchMaybeLiveCustodyVault(rpc, vaultPda, options),
    fetchMaybePlatform(rpc, platformPda, options),
    fetchMaybeAuthorityProposal(rpc, transferPda, options),
  ]);
  if (
    !vault.exists ||
    vault.programAddress !== ASSET_REGISTRY_PROGRAM_ADDRESS ||
    (await findCustodyVaultPda(vault.data.shareClass, vault.data.vaultId)) !==
      vaultPda ||
    !platform.exists ||
    platform.programAddress !== ASSET_REGISTRY_PROGRAM_ADDRESS
  )
    throw new Error("Custody authority could not be verified");
  if (
    transfer.exists &&
    (transfer.programAddress !== ASSET_REGISTRY_PROGRAM_ADDRESS ||
      transfer.data.target !== vaultPda)
  )
    throw new Error("Custody authority proposal is invalid");
  const stale =
    transfer.exists &&
    (transfer.data.proposedBy !== platform.data.admin ||
      transfer.data.currentAuthority !== vault.data.authority);
  return {
    vaultPda,
    platformPda,
    transferPda,
    current: vault.data.authority,
    superAdmin: platform.data.admin,
    vaultState: vault.data.state,
    proposed: transfer.exists ? transfer.data.newAuthority : null,
    proposedBy: transfer.exists ? transfer.data.proposedBy : null,
    expiresAt: transfer.exists ? transfer.data.expiresAt : null,
    stale,
  };
}

/**
 * `cancel_custody_authority_transfer`: withdraws a staged custody rotation
 * (live, stale or expired). The Super Admin may always cancel; the vault's
 * current operator only while it holds a live Admin record (an operator
 * removed for cause cannot block its own replacement). The rent returns to
 * the proposer.
 */
export async function buildCancelCustodyAuthorityTransfer(
  rpc: Rpc,
  vaultPda: Address,
  signer: TransactionSigner,
) {
  const state = await loadCustodyAuthority(rpc, vaultPda);
  if (!state.proposed || !state.proposedBy)
    throw new Error("No custody operator proposal is staged for this vault");
  if (signer.address !== state.superAdmin) {
    if (signer.address !== state.current)
      throw new Error(
        "Only the Super Admin or the vault's current custody operator can cancel this proposal",
      );
    const [record] = await findAdminRecordPda({ authority: signer.address });
    const admin = await fetchMaybeAdmin(rpc, record, {
      commitment: "finalized",
      abortSignal: AbortSignal.timeout(8_000),
    });
    if (
      !admin.exists ||
      admin.programAddress !== ASSET_REGISTRY_PROGRAM_ADDRESS ||
      admin.data.admin !== signer.address
    )
      throw new Error(
        "The custody operator can cancel only while it holds a live Admin role; ask the Super Admin",
      );
  }
  return getCancelCustodyAuthorityTransferInstructionAsync({
    canceller: signer,
    platform: state.platformPda,
    custodyVault: vaultPda,
    transfer: state.transferPda,
    proposer: state.proposedBy,
  });
}
export async function buildCustodyAuthorityChange(
  rpc: Rpc,
  vaultPda: Address,
  signer: TransactionSigner,
  action: "propose" | "accept",
  next?: string,
) {
  const state = await loadCustodyAuthority(rpc, vaultPda);
  const newAuthority =
    action === "propose" ? address(next ?? "") : signer.address;
  if (!isCustodyRotatable(state.vaultState))
    throw new Error(
      "Custody responsibility can move only while the vault is Active or Triggered",
    );
  if (action === "propose" && state.superAdmin !== signer.address)
    throw new Error(
      "Only the current Super Admin may propose a custody operator",
    );
  if (action === "accept" && state.proposed !== signer.address)
    throw new Error(`Connect the proposed custody operator to accept (${PROPOSAL_NOT_FINALIZED_HINT})`);
  if (action === "accept" && state.stale)
    throw new Error(CUSTODY_STALE_PROPOSAL);
  if (newAuthority === state.current)
    throw new Error("Choose a different custody operator");
  const [newAdminRecord] = await findAdminRecordPda({
    authority: newAuthority,
  });
  const admin = await fetchMaybeAdmin(rpc, newAdminRecord, {
    commitment: "finalized",
    abortSignal: AbortSignal.timeout(8_000),
  });
  if (
    !admin.exists ||
    admin.programAddress !== ASSET_REGISTRY_PROGRAM_ADDRESS ||
    admin.data.admin !== newAuthority
  )
    throw new Error(
      "The replacement custody operator must have a current Admin role",
    );
  return action === "propose"
    ? getProposeCustodyAuthorityInstructionAsync({
        superAdmin: signer,
        platform: state.platformPda,
        custodyVault: vaultPda,
        newAdminRecord,
        transfer: state.transferPda,
        newAuthority,
      })
    : getAcceptCustodyAuthorityInstructionAsync({
        newAuthority: signer,
        platform: state.platformPda,
        custodyVault: vaultPda,
        newAdminRecord,
        transfer: state.transferPda,
      });
}

// ── What the custody operator's handlers report (/admin/custody) ───────────
//
// Pure companions of the realize / return handlers of the admin request
// queues: how far a custody action got before it failed (its audit row), the
// evidence lines a request row shows, and the vault's attestation hash. No
// React, no chain reads; tests/admin-custody-*.test.ts pin them.

/**
 * How far a custody action got: building its instructions, in the wallet /
 * send path, sent (signature known) and being recorded, or sent and reported
 * failed by the network.
 */
export type CustodySendStage = "build" | "send" | "record" | "chain-failed";

/**
 * The stage an audit row records for a custody action that did not complete:
 *   * `pre-send` — nothing reached the wallet: the instructions could not be
 *     built, or the pause / pilot-scope / maintenance / simulation gate
 *     refused the transaction before the wallet opened;
 *   * `wallet` — the wallet path failed: rejected by the user, or the send
 *     failed before a signature was known;
 *   * `sent-unrecorded` — the transaction was sent (its signature is kept)
 *     and its outcome is not recorded yet;
 *   * `sent-failed` — the transaction was sent and the network reported it
 *     failed: nothing moved, the signature is kept.
 */
export type CustodyFailureStage = "pre-send" | "wallet" | "sent-unrecorded" | "sent-failed";

/** Errors raised before the wallet opened (matched by name: the modules that throw them import nothing from here). */
const PRE_WALLET_REFUSALS: ReadonlySet<string> = new Set([
  "PausedFlowError",
  "ModuleDisabledFlowError",
  "KycOnlyFlowError",
  "MaintenanceModeError",
  "MaintenanceUnknownError",
  "SimulationRefusedError",
  "SimulationUnavailableError",
  "GateAccountSetError",
  "EarlierTransactionUnconfirmedError",
]);

/** True when `err`, or a cause of it, is a refusal raised before the wallet opened. */
export function isPreWalletRefusal(err: unknown): boolean {
  for (let cursor: unknown = err, depth = 0; cursor instanceof Error && depth < 6; cursor = cursor.cause, depth++) {
    if (PRE_WALLET_REFUSALS.has(cursor.name)) return true;
  }
  return false;
}

/** The failure stage of a custody action that threw `err` at `stage`. */
export function custodyFailureStage(stage: CustodySendStage, err: unknown, signature?: string): CustodyFailureStage {
  if (stage === "record" && signature !== undefined) return "sent-unrecorded";
  if (stage === "chain-failed" && signature !== undefined) return "sent-failed";
  if (stage === "build" || isPreWalletRefusal(err)) return "pre-send";
  return "wallet";
}

export type CustodyFailureAuditInput = {
  ix_name: string;
  actor_wallet: string;
  reason: string;
  target_label: string;
  /** What the handler knows: request id, vault PDA, attestation hash. */
  metadata: Record<string, unknown>;
  stage: CustodySendStage;
  /** The signature, once the transaction was sent. */
  signature?: string;
  err: unknown;
  /** The explanation shown to the operator (explainSendError). */
  message: string;
};

/**
 * The audit row of a custody action that did not complete. `failed` only
 * when nothing was sent; once a signature exists the row is `pending` (sent,
 * outcome not recorded) and keeps the signature — in tx_signature and in
 * metadata — so the retry or a reconciler can settle it by signature. The
 * stage tells a wallet rejection, a pre-wallet refusal and a landed but
 * unrecorded transaction apart.
 */
export function custodyFailureAudit(input: CustodyFailureAuditInput): AuditInput {
  const stage = custodyFailureStage(input.stage, input.err, input.signature);
  const sent = stage === "sent-unrecorded";
  return {
    ix_name: input.ix_name,
    category: "custody",
    actor_wallet: input.actor_wallet,
    reason: input.reason,
    target_label: input.target_label,
    status: sent ? "pending" : "failed",
    ...(input.signature !== undefined ? { tx_signature: input.signature } : {}),
    metadata: {
      ...input.metadata,
      signature: input.signature ?? null,
      stage,
      error: input.message,
    },
  };
}

/** One evidence line of a request row: a transaction and what the server verified about it. */
export type CustodyEvidenceLine = {
  kind: "deposit" | "burn" | "return" | "close";
  signature: string;
  /** The server verified this transaction against the vault (deposit_evidence / outcome_evidence). */
  verified: boolean;
  text: string;
};

/** The request-row columns the evidence lines read (a ConversionRequest or DeliveryRequest fits). */
export type CustodyEvidenceRow = {
  status: string;
  amount: number | string;
  deposit_tx: string | null;
  outcome_tx: string | null;
  deposit_evidence?: unknown;
  outcome_evidence?: unknown;
};

type VerifiedProof = { slot: string; amountAtomic: string; surplusRemaining: string | null };

const DIGITS = /^\d+$/;

/** The proof when it is the server's evidence of exactly `signature`; null otherwise. */
function verifiedProof(evidence: unknown, signature: string): VerifiedProof | null {
  if (!evidence || typeof evidence !== "object") return null;
  const e = evidence as Record<string, unknown>;
  if (e.signature !== signature) return null;
  const slot = typeof e.slot === "string" ? e.slot : typeof e.slot === "number" ? String(e.slot) : "";
  const amountAtomic = typeof e.amountAtomic === "string" ? e.amountAtomic : typeof e.amountAtomic === "number" ? String(e.amountAtomic) : "";
  if (!DIGITS.test(slot) || !DIGITS.test(amountAtomic)) return null;
  const surplus = typeof e.surplusRemaining === "string" && DIGITS.test(e.surplusRemaining) ? e.surplusRemaining : null;
  return { slot, amountAtomic, surplusRemaining: surplus };
}

/**
 * The evidence lines of a request row, in order: the holder's deposit, then
 * the outcome (the burn of a converted / delivered request, the return of a
 * returned one, the vault close of a cancelled one). A line is verified only
 * when the stored evidence is the server's proof of that very signature.
 * Never throws: malformed evidence reads as unverified.
 */
export function custodyRequestEvidence(row: CustodyEvidenceRow): CustodyEvidenceLine[] {
  const lines: CustodyEvidenceLine[] = [];
  const requested = String(row.amount);
  if (row.deposit_tx) {
    const proof = verifiedProof(row.deposit_evidence, row.deposit_tx);
    lines.push({
      kind: "deposit",
      signature: row.deposit_tx,
      verified: proof !== null,
      text: proof ? `Deposit verified: ${proof.amountAtomic} units · slot ${proof.slot}` : "Deposit (not verified)",
    });
  }
  if (row.outcome_tx) {
    const proof = verifiedProof(row.outcome_evidence, row.outcome_tx);
    if (row.status === "converted" || row.status === "delivered") {
      const mismatch = proof && proof.amountAtomic !== requested ? ` (request ${requested})` : "";
      lines.push({
        kind: "burn",
        signature: row.outcome_tx,
        verified: proof !== null,
        text: proof ? `Burn verified: ${proof.amountAtomic} units · slot ${proof.slot}${mismatch}` : "Burn (not verified)",
      });
    } else if (row.status === "returned") {
      const surplus = proof?.surplusRemaining && proof.surplusRemaining !== "0" ? ` · surplus left in vault: ${proof.surplusRemaining}` : "";
      lines.push({
        kind: "return",
        signature: row.outcome_tx,
        verified: proof !== null,
        text: proof ? `Return verified: ${proof.amountAtomic} units · slot ${proof.slot}${surplus}` : "Return (not verified)",
      });
    } else {
      lines.push({ kind: "close", signature: row.outcome_tx, verified: false, text: "Vault close tx (not verified)" });
    }
  }
  return lines;
}

/** The server-verified settlement of a vault, read from its linked request. */
export type CustodySettlementProof = {
  kind: "burn" | "return";
  signature: string;
  amountAtomic: string;
  slot: string;
};

/**
 * What settled a terminal vault, from the outcome evidence of its linked
 * request (lib/reclaim-rent linkedCustodyRequests): the verified burn of a
 * converted / delivered request, else the verified return of a returned one.
 * Never the vault's own deposit ledger, which a realize leaves as it was.
 */
export function custodySettlementProof(
  linked: readonly { status: string; outcome_evidence?: unknown }[] | null | undefined,
): CustodySettlementProof | null {
  if (!linked) return null;
  const settlements: readonly [CustodySettlementProof["kind"], readonly string[]][] = [
    ["burn", ["converted", "delivered"]],
    ["return", ["returned"]],
  ];
  for (const [kind, statuses] of settlements) {
    for (const request of linked) {
      if (!statuses.includes(request.status)) continue;
      const e = request.outcome_evidence;
      if (!e || typeof e !== "object") continue;
      const { signature } = e as Record<string, unknown>;
      if (typeof signature !== "string" || !signature) continue;
      const proof = verifiedProof(e, signature);
      if (proof) return { kind, signature, amountAtomic: proof.amountAtomic, slot: proof.slot };
    }
  }
  return null;
}

/**
 * The vault's attestation (`metadata_hash`, the sha256 the burn attests) as
 * lowercase hex, or null for the all-zero hash of a legacy vault opened
 * without one.
 */
export function custodyAttestationHex(hash: Iterable<number>): string | null {
  let hex = "";
  let zero = true;
  for (const byte of hash) {
    if (byte !== 0) zero = false;
    hex += byte.toString(16).padStart(2, "0");
  }
  return zero || hex.length === 0 ? null : hex;
}

// ── Waiting for the burn (confirmConversion / confirmDelivery) ─────────────
//
// The evidence API records a realize only once it reads it at `finalized`
// (lib/server/custody-evidence.ts recordRealization): a recording sent the
// moment the transaction is submitted is refused as "not finalized". The
// handler therefore waits — with the receipt already saved — until the
// signature is finalized before it records, so the first recording is the
// one that succeeds and "Retry recording" stays the exception, not the rule.

/** How long the handler waits for the realize to be finalized before it records it. */
export const REALIZE_FINALITY_TIMEOUT_MS = 45_000;

/** The longest one status read may take (the RPC transport has no timeout of its own). */
const FINALITY_READ_TIMEOUT_MS = 10_000;

export type FinalityOutcome = "finalized" | "failed" | "timeout";

/**
 * Polls one signature until the network reports it finalized, failed (the
 * transaction landed with an error), or `timeoutMs` passes. A read that
 * fails, or a status not known yet, counts as "not yet". Never throws: the
 * caller decides what a timeout means (the handler records anyway and lets
 * the server's answer stand, with the receipt saved for a retry).
 */
export async function waitForFinalizedSignature(
  rpc: KitRpc<GetSignatureStatusesApi>,
  signature: string,
  opts: { timeoutMs?: number; pollMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<FinalityOutcome> {
  const timeoutMs = opts.timeoutMs ?? REALIZE_FINALITY_TIMEOUT_MS;
  const pollMs = opts.pollMs ?? 2_000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const { value } = await rpc
        .getSignatureStatuses([signature as Signature])
        .send({ abortSignal: AbortSignal.timeout(FINALITY_READ_TIMEOUT_MS) });
      const status = value[0];
      if (status?.err) return "failed";
      if (status?.confirmationStatus === "finalized") return "finalized";
    } catch {
      // A failed read counts as "not yet".
    }
    if (Date.now() + pollMs > deadline) return "timeout";
    await sleep(pollMs);
  }
}
