// Chain side of "Tokenize company shares" (the rules are lib/tokenize-shares.ts).
//
// One transaction carries create_asset + add_share_class +
// initialize_share_class_mint when the wallet holds the Mint permission (an
// Admin always does): 863 B for the first real case and under 900 B at the
// flow's longest name / symbol / asset ID, against the 1232 B packet limit
// minus the send path's compute-budget instructions and reserve
// (tests/tokenize-shares.test.ts measures it with the real builders). With
// the CONVERSION permission it also carries the conversion marker (C2:
// add_share_class(1, capped at 0, no mint) + set_convertible_to(0 → 1)):
// 949 B for the real case, 983 B at the flow's longest name and 1027 B at
// the program's maxima — still one transaction and one signature. Every
// transaction is measured and simulated here before the wallet opens.

import {
  appendTransactionMessageInstructions,
  blockhash,
  compileTransaction,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type AccountMeta,
  type Address,
  type Instruction,
  type ReadonlyUint8Array,
  type TransactionSigner,
} from "@solana/kit";
import type { SolanaClient } from "@solana/client";
import { fetchMaybeToken, findAssociatedTokenPda } from "@solana-program/token-2022";
import {
  ASSET_REGISTRY_PROGRAM_ADDRESS,
  AssetRegistryInstruction,
  KybStatus,
  identifyAssetRegistryInstruction,
  parseAddShareClassInstruction,
  parseCreateAssetInstruction,
  parseInitializeShareClassMintInstruction,
  parseSetConvertibleToInstruction,
  fetchAllMaybeAsset,
  fetchMaybeAsset,
  fetchMaybeIssuer,
  fetchMaybeShareClass,
  findAssetPda,
  findMintPda,
  getAddShareClassInstructionAsync,
  getCreateAssetInstructionAsync,
  getInitializeShareClassMintInstructionAsync,
  getSetConvertibleToInstruction,
  type Asset,
  type AssetStatus,
  type ShareClass,
} from "@/lib/generated/asset_registry";
import {
  fetchMaybeTransferHookConfig,
  findConfigPda,
  findExtraAccountMetaListPda,
  RestrictionMode,
  TRANSFER_HOOK_PROGRAM_ADDRESS,
} from "@/lib/generated/transfer_hook";
import {
  MAX_COMPUTE_UNIT_LIMIT,
  SEND_OVERHEAD_INSTRUCTIONS,
  TRANSACTION_SIZE_LIMIT,
  setComputeUnitLimitInstruction,
  transactionSize,
} from "@/lib/compute-budget";
import { SEND_RESERVE_BYTES } from "@/lib/issuer-authority";
import { startFinalityPoll } from "@/lib/finality-poll";
import { findShareClassPda } from "@/lib/pdas";
import { confirmThenReport } from "@/lib/send-outcome";
import type { SignatureOutcome } from "@/lib/simulation-gate";
import type { AuditInput } from "@/lib/supabase";
import {
  CLASS_DEFAULTS,
  CLASS_INDEX,
  MARKER_CLASS_INDEX,
  MARKER_DEFAULTS,
  assetDefaults,
  chooseAssetId,
  conversionMarkerState,
  isResumable,
  markerLinks,
  nextTokenizeStep,
  type AssetSnapshot,
  type ClassSnapshot,
  type MarkerAction,
  type MarkerState,
  type TokenizeIntent,
  type TokenizeStep,
} from "@/lib/tokenize-shares";

export type Rpc = SolanaClient["runtime"]["rpc"];

export const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" as Address;

/** What a batched transaction may use: the packet limit minus the send path's reserve. */
export const TOKENIZE_TX_LIMIT = TRANSACTION_SIZE_LIMIT - SEND_RESERVE_BYTES;

export type TokenizeAddresses = { asset: Address; shareClass: Address; mint: Address };

export async function tokenizeAddresses(issuer: Address, assetId: string): Promise<TokenizeAddresses> {
  const [asset] = await findAssetPda({ issuer, assetId });
  const shareClass = await findShareClassPda(asset, CLASS_INDEX);
  const [mint] = await findMintPda({ shareClass });
  return { asset, shareClass, mint };
}

export type BuildTokenizeInput = {
  /** create: all three; add_class: class (+ mint); init_mint: the mint only; add_marker: the marker only. */
  kind: "create" | "add_class" | "init_mint" | "add_marker";
  /** create / add_class: also initialize the mint (needs `adminRecord`). */
  initMint: boolean;
  signer: TransactionSigner;
  issuer: Address;
  assetId: string;
  name: string;
  symbolPrefix: string;
  legalDocHash: Uint8Array;
  tokens: bigint;
  /** The issuer-permission proof (lib/issuer-permissions loadIssuerPermission). */
  adminRecord: Address | null;
  /**
   * The conversion marker (markerAction): add class 1 and link class 0 to it,
   * only add it, or only link it. Linking needs `adminRecord` with the
   * CONVERSION capability; adding needs only the issuer authority.
   */
  marker?: MarkerAction;
};

/** The instructions of one step, in program order. */
export async function buildTokenizeIxs(input: BuildTokenizeInput): Promise<Instruction[]> {
  const { asset, shareClass, mint } = await tokenizeAddresses(input.issuer, input.assetId);
  const marker = input.marker ?? null;
  const ixs: Instruction[] = [];
  if (input.kind === "create") {
    const defaults = assetDefaults();
    ixs.push(
      await getCreateAssetInstructionAsync({
        authority: input.signer,
        issuer: input.issuer,
        asset,
        assetId: input.assetId,
        assetType: defaults.assetType,
        name: input.name,
        symbolPrefix: input.symbolPrefix,
        legalDocHash: input.legalDocHash,
        jurisdictionRules: defaults.jurisdictionRules,
      }),
    );
  }
  if (input.kind === "create" || input.kind === "add_class") {
    ixs.push(
      await getAddShareClassInstructionAsync({
        authority: input.signer,
        issuer: input.issuer,
        asset,
        shareClass,
        classIndex: CLASS_DEFAULTS.classIndex,
        classType: CLASS_DEFAULTS.classType,
        rightsBitfield: CLASS_DEFAULTS.rightsBitfield,
        liqPrefMultiplierBps: CLASS_DEFAULTS.liqPrefMultiplierBps,
        liqSeniority: CLASS_DEFAULTS.liqSeniority,
        votingWeight: CLASS_DEFAULTS.votingWeight,
        maxSupply: input.tokens,
        mintablePostLaunch: CLASS_DEFAULTS.mintablePostLaunch,
      }),
    );
  }
  const markerClass = await findShareClassPda(asset, MARKER_CLASS_INDEX);
  // Class 1 right after class 0 (add_share_class takes the next index).
  if (marker === "add_and_link" || marker === "add") {
    ixs.push(
      await getAddShareClassInstructionAsync({
        authority: input.signer,
        issuer: input.issuer,
        asset,
        shareClass: markerClass,
        classIndex: MARKER_DEFAULTS.classIndex,
        classType: MARKER_DEFAULTS.classType,
        rightsBitfield: MARKER_DEFAULTS.rightsBitfield,
        liqPrefMultiplierBps: MARKER_DEFAULTS.liqPrefMultiplierBps,
        liqSeniority: MARKER_DEFAULTS.liqSeniority,
        votingWeight: MARKER_DEFAULTS.votingWeight,
        maxSupply: MARKER_DEFAULTS.maxSupply,
        mintablePostLaunch: MARKER_DEFAULTS.mintablePostLaunch,
      }),
    );
  }
  if (input.kind === "init_mint" || (input.kind !== "add_marker" && input.initMint)) {
    if (!input.adminRecord) throw new Error("Initializing the mint needs the Mint permission.");
    const [hookConfig] = await findConfigPda({ mint });
    const [extraAccountMetaList] = await findExtraAccountMetaListPda({ mint });
    ixs.push(
      await getInitializeShareClassMintInstructionAsync({
        authority: input.signer,
        adminRecord: input.adminRecord,
        issuer: input.issuer,
        asset,
        shareClass,
        mint,
        hookConfig,
        extraAccountMetaList,
        transferHookProgram: TRANSFER_HOOK_PROGRAM_ADDRESS,
        tokenProgram: TOKEN_2022_PROGRAM,
      }),
    );
  }
  if (markerLinks(marker)) {
    if (!input.adminRecord) throw new Error("Linking the conversion target needs the Conversion permission.");
    ixs.push(
      getSetConvertibleToInstruction({
        authority: input.signer,
        adminRecord: input.adminRecord,
        issuer: input.issuer,
        asset,
        shareClass,
        targetShareClass: markerClass,
      }),
    );
  }
  if (input.kind === "add_marker" && marker === null) throw new Error("No conversion marker to add.");
  return ixs;
}

/** Size with the compute-budget instructions the send path adds. */
export function tokenizeTransactionSize(feePayer: Address, ixs: readonly Instruction[]): number {
  return transactionSize(feePayer, [...SEND_OVERHEAD_INSTRUCTIONS, ...ixs]);
}

/** Refuses a transaction that would not fit once sent. */
export function assertTokenizeFits(feePayer: Address, ixs: readonly Instruction[]): number {
  const size = tokenizeTransactionSize(feePayer, ixs);
  if (size > TOKENIZE_TX_LIMIT) {
    throw new Error(`The transaction would be ${size} bytes, over the ${TOKENIZE_TX_LIMIT}-byte limit. Shorten the name.`);
  }
  return size;
}

/** The unsigned transaction a simulation runs (the network replaces the blockhash). */
export function simulationWire(feePayer: Address, ixs: readonly Instruction[]) {
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(feePayer, m),
    (m) =>
      setTransactionMessageLifetimeUsingBlockhash(
        { blockhash: blockhash("11111111111111111111111111111111"), lastValidBlockHeight: BigInt(0) },
        m,
      ),
    (m) => appendTransactionMessageInstructions([setComputeUnitLimitInstruction(MAX_COMPUTE_UNIT_LIMIT), ...ixs], m),
  );
  return getBase64EncodedWireTransaction(compileTransaction(message));
}

/**
 * Runs the exact instructions on the network without signing, before the
 * wallet opens. A refusal throws an Error that carries the program logs, so
 * lib/tx-error explainSendError words it like a failed send.
 */
export async function simulateTokenize(
  rpc: Rpc,
  feePayer: Address,
  ixs: readonly Instruction[],
): Promise<bigint | null> {
  const { value } = await rpc
    .simulateTransaction(simulationWire(feePayer, ixs), {
      encoding: "base64",
      sigVerify: false,
      replaceRecentBlockhash: true,
      commitment: "confirmed",
    })
    .send();
  if (value.err) {
    throw Object.assign(
      new Error("The network refused this transaction in a dry run, so nothing was sent to your wallet."),
      { logs: [...(value.logs ?? [])] },
    );
  }
  return value.unitsConsumed ?? null;
}

export type HookMode = "open" | "kyc-gated" | "none";

export type TokenizeChainState = {
  addresses: { asset: Address; shareClass: Address; markerClass: Address };
  asset: Asset | null;
  sc0: ShareClass | null;
  /** Class 1 (the conversion marker when the flow made it), or null. */
  sc1: ShareClass | null;
  marker: MarkerState;
  /** null while class 0 has no mint (no hook config yet). */
  hook: HookMode | null;
};

/** The marker state from the chain accounts (class 1's address is its PDA). */
export function markerStateOf(asset: Asset | null, sc0: ShareClass | null, sc1: ShareClass | null, markerClass: Address): MarkerState {
  return conversionMarkerState({
    shareClassesCount: asset?.shareClassesCount ?? 0,
    sc0: sc0 ? classSnapshot(sc0) : null,
    sc1: sc1 ? classSnapshot(sc1) : null,
    sc1Pda: markerClass,
  });
}

/** The asset, its classes 0 and 1 and class 0's transfer-hook mode, at `confirmed`. */
export async function readTokenizeState(rpc: Rpc, assetPda: Address): Promise<TokenizeChainState> {
  const options = { commitment: "confirmed" as const };
  const shareClass = await findShareClassPda(assetPda, CLASS_INDEX);
  const markerClass = await findShareClassPda(assetPda, MARKER_CLASS_INDEX);
  const [asset, sc0, sc1] = await Promise.all([
    fetchMaybeAsset(rpc, assetPda, options),
    fetchMaybeShareClass(rpc, shareClass, options),
    fetchMaybeShareClass(rpc, markerClass, options),
  ]);
  let hook: HookMode | null = null;
  if (sc0.exists && sc0.data.mintInitialized) {
    const [config] = await findConfigPda({ mint: sc0.data.mint });
    const cfg = await fetchMaybeTransferHookConfig(rpc, config, options);
    hook = !cfg.exists ? "none" : cfg.data.restrictionMode === RestrictionMode.KycGated ? "kyc-gated" : "open";
  }
  const a = asset.exists ? asset.data : null;
  const c0 = sc0.exists ? sc0.data : null;
  const c1 = sc1.exists ? sc1.data : null;
  return {
    addresses: { asset: assetPda, shareClass, markerClass },
    asset: a,
    sc0: c0,
    sc1: c1,
    marker: markerStateOf(a, c0, c1, markerClass),
    hook,
  };
}

/**
 * The issuer treasury's balance of `mint`, exact: 0 when the treasury has no
 * token account (nothing was ever created into it, or it was emptied and
 * closed — an account can only be closed empty), null only when it cannot
 * be read or is not the owner's account of this mint.
 */
export async function readTreasuryBalance(rpc: Rpc, owner: Address, mint: Address): Promise<bigint | null> {
  try {
    const [ata] = await findAssociatedTokenPda({ owner, mint, tokenProgram: TOKEN_2022_PROGRAM });
    const account = await fetchMaybeToken(rpc, ata, { commitment: "confirmed" });
    if (!account.exists) return BigInt(0);
    if (account.data.mint !== mint || account.data.owner !== owner) return null;
    return account.data.amount;
  } catch {
    return null;
  }
}

/** Whether the issuer's KYB is Verified on chain right now (create() re-checks it before signing). */
export async function issuerKybVerified(rpc: Rpc, issuerPda: Address): Promise<boolean> {
  const issuer = await fetchMaybeIssuer(rpc, issuerPda, { commitment: "confirmed" });
  return issuer.exists && issuer.data.kybStatus === KybStatus.Verified;
}

export function assetSnapshot(a: Asset): AssetSnapshot {
  return {
    assetType: a.assetType,
    status: a.status,
    name: a.name,
    symbolPrefix: a.symbolPrefix,
    shareClassesCount: a.shareClassesCount,
  };
}

export function classSnapshot(sc: ShareClass): ClassSnapshot {
  return {
    classType: sc.classType,
    maxSupply: sc.maxSupply.__option === "Some" ? sc.maxSupply.value : null,
    mintablePostLaunch: sc.mintablePostLaunch,
    mintInitialized: sc.mintInitialized,
    rightsBitfield: sc.rightsBitfield,
    liqPrefMultiplierBps: sc.liqPrefMultiplierBps,
    liqSeniority: sc.liqSeniority,
    votingWeight: sc.votingWeight,
    convertibleTo: sc.convertibleTo.__option === "Some" ? sc.convertibleTo.value.toString() : null,
  };
}

/** An existing asset under one of the earlier candidate IDs, shown before a second token is made. */
export type ExistingTokenizeAsset = {
  assetId: string;
  assetPda: Address;
  name: string;
  symbolPrefix: string;
  status: AssetStatus;
  step: TokenizeStep;
};

export type TokenizeAssetPick = {
  assetId: string;
  assetPda: Address;
  step: TokenizeStep;
  /** Existing assets passed over (see needsDuplicateConfirmation). */
  skipped: ExistingTokenizeAsset[];
};

/**
 * The asset ID for `intent`, checked on chain before anything is signed: one
 * read of every candidate (base, base-2, …), class 0 of an existing one, and
 * — only when the chain part is complete — whether its details were saved.
 * Returns the first free ID, or an earlier unfinished asset of the same terms
 * to continue; null when every candidate is taken. Existing assets passed
 * over come back in `skipped`, so the caller asks before creating another.
 */
export async function pickTokenizeAssetId(
  rpc: Rpc,
  input: {
    issuer: Address;
    candidates: readonly string[];
    intent: TokenizeIntent;
    canInitMint: boolean;
    /** The wallet holds the CONVERSION permission (the marker step). */
    canConvert?: boolean;
    profileSaved: (assetPda: Address) => Promise<boolean>;
  },
): Promise<TokenizeAssetPick | null> {
  const pdas = await Promise.all(
    input.candidates.map(async (assetId) => (await findAssetPda({ issuer: input.issuer, assetId }))[0]),
  );
  const assets = await fetchAllMaybeAsset(rpc, pdas, { commitment: "confirmed" });
  const steps: TokenizeStep[] = [];
  for (let i = 0; i < assets.length; i++) {
    const a = assets[i];
    const base = { canInitMint: input.canInitMint, intent: input.intent, canConvert: input.canConvert ?? false };
    if (!a.exists) {
      steps.push(nextTokenizeStep({ ...base, asset: null, sc0: null, profileSaved: false }));
      break;
    }
    let sc0: ShareClass | null = null;
    let sc1: ShareClass | null = null;
    const markerClass = await findShareClassPda(pdas[i], MARKER_CLASS_INDEX);
    if (a.data.shareClassesCount > 0) {
      const [c0, c1] = await Promise.all([
        fetchMaybeShareClass(rpc, await findShareClassPda(pdas[i], CLASS_INDEX), { commitment: "confirmed" }),
        a.data.shareClassesCount > 1 ? fetchMaybeShareClass(rpc, markerClass, { commitment: "confirmed" }) : null,
      ]);
      sc0 = c0.exists ? c0.data : null;
      sc1 = c1?.exists ? c1.data : null;
    }
    const marker = markerStateOf(a.data, sc0, sc1, markerClass);
    const asset = assetSnapshot(a.data);
    const snapshot = sc0 ? classSnapshot(sc0) : null;
    let step = nextTokenizeStep({ ...base, asset, sc0: snapshot, marker, profileSaved: true });
    if (step.kind === "done" || step.kind === "wait_mint_permission") {
      step = nextTokenizeStep({ ...base, asset, sc0: snapshot, marker, profileSaved: await input.profileSaved(pdas[i]) });
    }
    steps.push(step);
    if (step.kind === "create" || isResumable(step)) break;
  }
  const chosen = chooseAssetId(input.candidates, steps);
  if (!chosen) return null;
  const skipped = chosen.skipped.map(({ assetId, step }): ExistingTokenizeAsset => {
    const i = input.candidates.indexOf(assetId);
    const a = assets[i];
    if (!a.exists) throw new Error(`Asset ${assetId} was reported as existing but is missing.`);
    return {
      assetId,
      assetPda: pdas[i],
      name: a.data.name,
      symbolPrefix: a.data.symbolPrefix,
      status: a.data.status,
      step,
    };
  });
  return { assetId: chosen.assetId, step: chosen.step, skipped, assetPda: pdas[input.candidates.indexOf(chosen.assetId)] };
}

/**
 * Resolves true once the asset is visible at `finalized` (what the profile
 * route checks ownership at), false after `attempts` polls or on abort.
 */
export function waitForFinalizedAsset(
  rpc: Rpc,
  assetPda: Address,
  opts: { intervalMs?: number; attempts?: number; signal?: AbortSignal } = {},
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const stop = startFinalityPoll(
      async () => {
        const a = await fetchMaybeAsset(rpc, assetPda, { commitment: "finalized" });
        if (a.exists) finish(true);
        return a.exists;
      },
      { intervalMs: opts.intervalMs ?? 4_000, attempts: opts.attempts ?? 45, onGiveUp: () => finish(false) },
    );
    opts.signal?.addEventListener("abort", () => {
      stop();
      finish(false);
    });
  });
}

// ── Audit ───────────────────────────────────────────────────────────────────

/** Which tokenize step sent the transaction (the audit rows say it). */
export type TokenizeAuditStep = "create" | "add_class" | "init_mint" | "add_marker";

function bytesHex(bytes: ArrayLike<number>): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * One audit_events row per registry instruction the tokenize transaction
 * carried, in program order, read from the instructions themselves (so the
 * ledger names exactly what was signed): create_asset, add_share_class (class
 * 0, and class 1 — the conversion marker), initialize_share_class_mint and
 * set_convertible_to. They share the transaction signature; `status` is set
 * by auditTokenizeOutcome once the network decided.
 */
export function tokenizeAuditRows(
  ixs: readonly Instruction[],
  input: { actor: string; signature: string; name: string; step: TokenizeAuditStep },
): AuditInput[] {
  const reason = `Tokenize company shares: ${input.name}`;
  const rows: AuditInput[] = [];
  for (const ix of ixs) {
    if (ix.programAddress !== ASSET_REGISTRY_PROGRAM_ADDRESS || !ix.data || !ix.accounts) continue;
    const parsable = ix as Instruction & { accounts: readonly AccountMeta[]; data: ReadonlyUint8Array };
    const common = { actor_wallet: input.actor, reason, tx_signature: input.signature, status: "success" as const };
    const meta = { flow: "tokenize-shares", step: input.step };
    switch (identifyAssetRegistryInstruction(parsable.data)) {
      case AssetRegistryInstruction.CreateAsset: {
        const p = parseCreateAssetInstruction(parsable);
        rows.push({
          ...common, ix_name: "create_asset", category: "assets", target_label: p.accounts.asset.address,
          metadata: {
            ...meta, issuer: p.accounts.issuer.address, asset_id: p.data.assetId, name: p.data.name,
            symbol_prefix: p.data.symbolPrefix, legal_doc_sha256: bytesHex(p.data.legalDocHash),
          },
        });
        break;
      }
      case AssetRegistryInstruction.AddShareClass: {
        const p = parseAddShareClassInstruction(parsable);
        const maxSupply = p.data.maxSupply.__option === "Some" ? p.data.maxSupply.value.toString() : null;
        rows.push({
          ...common, ix_name: "add_share_class", category: "share-class", target_label: p.accounts.shareClass.address,
          metadata: {
            ...meta, asset: p.accounts.asset.address, class_index: p.data.classIndex, max_supply: maxSupply,
            mintable_post_launch: p.data.mintablePostLaunch,
            ...(p.data.classIndex === MARKER_CLASS_INDEX ? { conversion_marker: true } : {}),
          },
        });
        break;
      }
      case AssetRegistryInstruction.InitializeShareClassMint: {
        const p = parseInitializeShareClassMintInstruction(parsable);
        rows.push({
          ...common, ix_name: "initialize_share_class_mint", category: "share-class", target_label: p.accounts.shareClass.address,
          metadata: { ...meta, asset: p.accounts.asset.address, mint: p.accounts.mint.address },
        });
        break;
      }
      case AssetRegistryInstruction.SetConvertibleTo: {
        const p = parseSetConvertibleToInstruction(parsable);
        // The same metadata as /admin/share-classes' own set_convertible_to row.
        rows.push({
          ...common, ix_name: "set_convertible_to", category: "share-class", target_label: p.accounts.shareClass.address,
          metadata: { ...meta, asset: p.accounts.asset.address, target_share_class: p.accounts.targetShareClass?.address ?? null },
        });
        break;
      }
      default:
        break;
    }
  }
  return rows;
}

/**
 * Writes the tokenize transaction's audit rows once the network decided
 * (lib/send-outcome: `tx.send` returns when the transaction is submitted):
 * success, failed, or pending with the confirmation outcome when it is not
 * confirmed in time (it may still land). One row after another (the audit
 * route's burst limit). `record` never throws (recordAudit).
 */
export async function auditTokenizeOutcome(input: {
  rows: readonly AuditInput[];
  wait: () => Promise<SignatureOutcome>;
  record: (row: AuditInput) => Promise<unknown>;
}): Promise<SignatureOutcome> {
  const write = async (status: AuditInput["status"], extra: Record<string, unknown> = {}) => {
    for (const row of input.rows) await input.record({ ...row, status, metadata: { ...row.metadata, ...extra } });
  };
  return confirmThenReport(input.wait, {
    confirmed: () => write("success"),
    failed: () => write("failed", { error: "refused by the network" }),
    unconfirmed: (outcome) => write("pending", { confirmation: outcome }),
  });
}
