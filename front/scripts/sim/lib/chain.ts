/**
 * Chain side of the simulator (design-sim §0, §4, §7).
 *
 * - RPC: the chain CLI's genesis-pinned, method-allowlisted, throttled
 *   transport (createChainRpc, CHAIN_RPS=1) behind the RPC circuit breaker.
 * - Sends: the reviewed send path of scripts/chain/lib/tx.ts, exactly as the
 *   e2e runner uses it — sized unsigned at MAX CU, signed once, that wire
 *   simulated with sigVerify, the signature saved in state.json BEFORE the
 *   send, journalled (tx-journal.jsonl), sent with maxRetries 0 and polled to
 *   `finalized` (the server re-verifies purchases at finalized). One
 *   transaction in flight, at most 3 per minute.
 * - Resume: every signature still "inflight" is resolved first (batched
 *   getSignatureStatuses); unseen counts as dropped only after the finalized
 *   block height passed its lastValidBlockHeight.
 * - Builders: the app's own (buildDocumentedPurchase, buildTakeOfferInstructions,
 *   buildDepositOtcAssetInstructions, hookTransferMetas) and the generated
 *   instruction builders the pages use.
 */
import {
  SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR,
  createDefaultRpcTransport,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  isSolanaError,
  signTransactionMessageWithSigners,
  type Address,
  type Instruction,
  type KeyPairSigner,
  type RpcTransport,
  type Signature,
  type TransactionSigner,
} from "@solana/kit";
import {
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstructionAsync,
} from "@solana-program/token-2022";
import type { SaleDocumentTerms } from "@/lib/document-terms";
import {
  OfferStatus,
  OtcDealStatus,
  fetchMaybeOffer,
  fetchMaybeOtcDeal,
  fetchOffer,
  fetchOtcDeal,
  fetchSale,
  findIssuerPda,
  findPlatformPda,
  getCancelOfferInstructionAsync,
  getCreateOfferInstructionAsync,
  getDepositOtcPaymentInstructionAsync,
  getDepositToOfferEscrowInstruction,
  getExpireOfferInstructionAsync,
  getRegisterIssuerInstructionAsync,
} from "@/lib/generated/asset_registry";
import { toBytes32 } from "@/lib/format";
import { hookTransferMetas } from "@/lib/hook-metas";
import { buildDepositOtcAssetInstructions, buildTakeOfferInstructions } from "@/lib/otc-transactions";
import { getEntryPda } from "@/lib/passport";
import { findOfferPda } from "@/lib/pdas";
import { buildDocumentedPurchase } from "@/lib/purchase-builder";
import { TOKEN_2022, fetchPlainPaymentMintTokenProgram } from "@/lib/transaction-builders";
import { chainNow } from "@/scripts/chain/lib/e2e/clock";
import { classifyFailure, describeFailure, type ChainFailure } from "@/scripts/chain/lib/e2e/errors";
import { type Journal, readJournal, unresolvedSignatures } from "@/scripts/chain/lib/journal";
import { createChainRpc, type ChainRpc, type ChainRpcClients } from "@/scripts/chain/lib/rpc";
import { toJson } from "@/scripts/chain/lib/safety";
import {
  MAX_COMPUTE_UNITS,
  buildMessage,
  computeUnitLimit,
  simulateSigned,
  simulateUnsigned,
  submitAndConfirm,
  type SimulationResult,
  type Timing,
} from "@/scripts/chain/lib/tx";
import type { JournalSink } from "./journal";
import type { Limiter } from "./pacing";
import type { OfferRecord, SimState, TxOwner, TxRecord, UserState } from "./state";

// ── RPC ─────────────────────────────────────────────────────────────────────

/** The chain CLI's guarded RPC, with every 429 reported to the breaker and calls held while it is open. */
export function createSimRpc(input: {
  url: string;
  expectedGenesis: string;
  rps: number;
  limiter: Limiter;
  signal?: AbortSignal;
  transport?: RpcTransport;
}): ChainRpcClients {
  const base = input.transport ?? createDefaultRpcTransport({ url: input.url });
  const transport = (async <TResponse>(config: Parameters<RpcTransport>[0]): Promise<TResponse> => {
    await input.limiter.rpcReady();
    try {
      const response = await base<TResponse>(config);
      const code = (response as { error?: { code?: unknown } } | null)?.error?.code;
      if (code === 429) input.limiter.noteRpc429();
      return response;
    } catch (error) {
      if (isSolanaError(error, SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR) && error.context.statusCode === 429) {
        input.limiter.noteRpc429();
      }
      throw error;
    }
  }) as RpcTransport;
  return createChainRpc({
    url: input.url,
    network: "devnet",
    expectedGenesis: input.expectedGenesis,
    mode: "send",
    rps: input.rps,
    signal: input.signal,
    transport,
    // One genesis proof per 5 minutes is enough for a devnet-pinned run and saves the budget.
    genesisCacheMs: 300_000,
  });
}

// ── Transaction executor ─────────────────────────────────────────────────────

/** A simulation or a landed transaction failed; the report lists it. Nothing was re-sent. */
export class SimTxError extends Error {
  constructor(
    readonly label: string,
    readonly failure: ChainFailure | null,
    readonly logs: string[],
    message: string,
  ) {
    super(message);
    this.name = "SimTxError";
  }
}

/** The step cannot finish now (unresolved or expired signature, missing precondition); retry later. */
export class SimRetryLater extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SimRetryLater";
  }
}

export type OwnerMeta = { cohort: string; wave: number | null };

export type ExecutorDeps = {
  rpc: ChainRpc;
  drainRpc: ChainRpc;
  txJournal: Journal;
  journal: JournalSink;
  limiter: Limiter;
  persist: () => void;
  cuPrice?: bigint | null;
  timing?: Partial<Timing>;
  signal?: AbortSignal;
};

type StatusValue = { err: unknown; confirmationStatus?: string | null } | null;

export class TxExecutor {
  constructor(private readonly d: ExecutorDeps) {}

  get rpc(): ChainRpc {
    return this.d.rpc;
  }

  private note(owner: TxOwner, meta: OwnerMeta, label: string, fields: { outcome: "ok" | "tx-error" | "info"; sig?: string | null; err?: string; logs?: string[] }) {
    this.d.journal.append({
      wave: meta.wave,
      user: owner.label,
      cohort: meta.cohort,
      step: label,
      kind: "tx",
      ix: label,
      outcome: fields.outcome,
      txSig: fields.sig ?? null,
      err: fields.err,
      logMessages: fields.logs,
    });
  }

  private settle(owner: TxOwner, label: string, record: TxRecord): void {
    owner.tx[label] = record;
    this.d.persist();
  }

  /** Classifies one looked-up status for an inflight record (null = not seen). */
  private decide(owner: TxOwner, meta: OwnerMeta, label: string, record: TxRecord, status: StatusValue, height: bigint | null): "landed" | "failed" | "dropped" | "pending" {
    const at = new Date().toISOString();
    if (status) {
      if (status.err) {
        const err = toJson(status.err, 0);
        this.settle(owner, label, { ...record, status: "failed", err, at });
        this.note(owner, meta, label, { outcome: "tx-error", sig: record.sig, err: `landed with an error (resolved on resume): ${err}` });
        return "failed";
      }
      if (status.confirmationStatus === "finalized") {
        this.settle(owner, label, { ...record, status: "landed", at });
        return "landed";
      }
      return "pending";
    }
    if (height !== null && record.lvbh && height > BigInt(record.lvbh)) {
      delete owner.tx[label];
      this.d.persist();
      this.note(owner, meta, label, { outcome: "info", sig: record.sig, err: "expired without landing; the step is rebuilt" });
      return "dropped";
    }
    return "pending";
  }

  /**
   * Resolves every inflight signature in one pass (≤256 per getSignatureStatuses
   * call), plus any signature the tx journal shows as unresolved.
   */
  async resolveAll(state: SimState, metaOf: (owner: TxOwner) => OwnerMeta): Promise<{ pending: number }> {
    const owners: TxOwner[] = [state.market, state.funding, ...Object.values(state.users)];
    const byLabel = new Map(owners.map((o) => [o.label, o]));
    // A signature the tx journal saw signed but state.json lost (crash between the two writes).
    for (const inflight of unresolvedSignatures(readJournal(this.d.txJournal.path))) {
      const [ownerLabel, ...rest] = inflight.step.split(":");
      const owner = byLabel.get(ownerLabel);
      const label = rest.join(":");
      if (owner && label && !owner.tx[label]) {
        owner.tx[label] = { status: "inflight", sig: inflight.sig, lvbh: inflight.lastValidBlockHeight.toString(), at: new Date().toISOString() };
      }
    }
    const pending = owners.flatMap((owner) =>
      Object.entries(owner.tx)
        .filter(([, r]) => r.status === "inflight" && r.sig)
        .map(([label, record]) => ({ owner, label, record })),
    );
    if (!pending.length) return { pending: 0 };
    let height: bigint | null = null;
    try {
      height = await this.d.rpc.getBlockHeight({ commitment: "finalized" }).send();
    } catch {
      height = null;
    }
    let left = 0;
    for (let i = 0; i < pending.length; i += 256) {
      const batch = pending.slice(i, i + 256);
      const { value } = await this.d.rpc
        .getSignatureStatuses(batch.map((p) => p.record.sig as Signature), { searchTransactionHistory: true })
        .send();
      batch.forEach((p, j) => {
        const result = this.decide(p.owner, metaOf(p.owner), p.label, p.record, value[j] as StatusValue, height);
        if (result === "pending") left += 1;
      });
    }
    return { pending: left };
  }

  /** True when this owner's step already landed. */
  landed(owner: TxOwner, label: string): boolean {
    return owner.tx[label]?.status === "landed";
  }

  /**
   * Sends one transaction for `owner` (idempotent per label): skipped when it
   * landed before or `done()` shows its effect; an inflight signature is
   * resolved, never re-signed.
   */
  async run(
    owner: TxOwner,
    meta: OwnerMeta,
    label: string,
    payer: TransactionSigner,
    build: () => Promise<Instruction[]>,
    options: { done?: () => Promise<boolean> } = {},
  ): Promise<{ signature: string | null; skipped: boolean }> {
    const prior = owner.tx[label];
    if (prior?.status === "landed") return { signature: prior.sig, skipped: true };
    if (prior?.status === "inflight") {
      const { value } = await this.d.rpc
        .getSignatureStatuses([prior.sig as Signature], { searchTransactionHistory: true })
        .send();
      const height = value[0] ? null : await this.d.rpc.getBlockHeight({ commitment: "finalized" }).send();
      const result = this.decide(owner, meta, label, prior, value[0] as StatusValue, height);
      if (result === "landed") return { signature: prior.sig, skipped: true };
      if (result === "failed") throw new SimTxError(label, null, [], `${label} landed with an error in an earlier run`);
      if (result === "pending") throw new SimRetryLater(`${label}: an earlier signature is still unresolved`);
    }
    if (options.done && (await options.done())) {
      this.settle(owner, label, { status: "landed", sig: null, at: new Date().toISOString() });
      return { signature: null, skipped: true };
    }
    const unlock = await this.d.limiter.lockTx();
    try {
      await this.d.limiter.acquire(["tx"], { http: false });
      const ixs = await build();
      const blockhash = (await this.d.rpc.getLatestBlockhash({ commitment: "confirmed" }).send()).value;
      const fail = (kind: string, simulation: SimulationResult): never => {
        const failure = classifyFailure(simulation.err, simulation.logs);
        const logs = simulation.logs.slice(-12);
        const err = `${kind} simulation failed: ${describeFailure(failure)}`;
        this.note(owner, meta, label, { outcome: "tx-error", err, logs });
        throw new SimTxError(label, failure, logs, `${label}: ${err}`);
      };
      const sizing = await simulateUnsigned(
        this.d.rpc,
        buildMessage({ feePayer: payer, ixs, blockhash, cuLimit: MAX_COMPUTE_UNITS, cuPrice: this.d.cuPrice ?? null }),
      );
      if (!sizing.ok) fail("sizing", sizing);
      const message = buildMessage({ feePayer: payer, ixs, blockhash, cuLimit: computeUnitLimit(sizing.unitsConsumed), cuPrice: this.d.cuPrice ?? null });
      const signed = await signTransactionMessageWithSigners(message);
      const wire = getBase64EncodedWireTransaction(signed);
      const signature = getSignatureFromTransaction(signed);
      const exact = await simulateSigned(this.d.rpc, wire);
      if (!exact.ok) fail("signed", exact);
      // The signature is on disk before the send: a crash can only leave an inflight record.
      this.settle(owner, label, {
        status: "inflight",
        sig: signature,
        lvbh: blockhash.lastValidBlockHeight.toString(),
        at: new Date().toISOString(),
      });
      const outcome = await submitAndConfirm({
        drainRpc: this.d.drainRpc,
        journal: this.d.txJournal,
        step: `${owner.label}:${label}`,
        wire,
        signature,
        lastValidBlockHeight: blockhash.lastValidBlockHeight,
        required: "finalized",
        signal: this.d.signal,
        timing: this.d.timing,
      });
      const at = new Date().toISOString();
      if (outcome.status === "finalized") {
        this.settle(owner, label, { status: "landed", sig: signature, at });
        this.note(owner, meta, label, { outcome: "ok", sig: signature });
        return { signature, skipped: false };
      }
      if (outcome.status === "failed") {
        const failure = classifyFailure(outcome.err, []);
        const err = `failed on-chain: ${toJson(outcome.err, 0)} (${describeFailure(failure)})`;
        this.settle(owner, label, { status: "failed", sig: signature, at, err });
        this.note(owner, meta, label, { outcome: "tx-error", sig: signature, err });
        throw new SimTxError(label, failure, [], `${label} ${err}`);
      }
      if (outcome.status === "dropped") {
        delete owner.tx[label];
        this.d.persist();
        this.note(owner, meta, label, { outcome: "info", sig: signature, err: "expired without landing" });
        throw new SimRetryLater(`${label} expired without landing`);
      }
      throw new SimRetryLater(`${label} ${outcome.status}; resolved on the next pass`);
    } finally {
      unlock();
    }
  }
}

// ── Market operations used by the cohorts ───────────────────────────────────

export type MarketAddrs = {
  issuer: Address;
  asset: Address;
  classA: Address;
  mintA: Address;
  paymentMint: Address;
  /** The KYC registry whose KycEntry proves a passport (null: HTTP checks only). */
  kycRegistry: Address | null;
};

export type OfferView = { status: OfferStatus; deposited: bigint; expiresAt: bigint; maker: string };
export type DealView = { status: OtcDealStatus; assetDeposited: boolean; paymentDeposited: boolean; seller: string; buyer: string };

/** What a cohort may do on chain. Faked in the offline tests. */
export interface ChainOps {
  now(): Promise<bigint>;
  buy(u: UserState, signer: KeyPairSigner, sale: Address, amount: bigint, terms: SaleDocumentTerms): Promise<string | null>;
  createOffer(u: UserState, signer: KeyPairSigner, key: string, offer: OfferRecord): Promise<void>;
  depositOffer(u: UserState, signer: KeyPairSigner, key: string, offer: OfferRecord): Promise<void>;
  cancelOffer(u: UserState, signer: KeyPairSigner, key: string, offer: OfferRecord): Promise<void>;
  takeOffer(u: UserState, signer: KeyPairSigner, key: string, offerPda: Address): Promise<void>;
  expireOffer(u: UserState, signer: KeyPairSigner, key: string, offerPda: Address): Promise<void>;
  offer(pda: Address): Promise<OfferView | null>;
  offerPda(offerId: bigint): Promise<Address>;
  registerIssuer(u: UserState, signer: KeyPairSigner, legalId: string, jurisdiction: number): Promise<Address>;
  depositDealAsset(u: UserState, signer: KeyPairSigner, dealPda: Address): Promise<void>;
  depositDealPayment(u: UserState, signer: KeyPairSigner, dealPda: Address): Promise<void>;
  deal(pda: Address): Promise<DealView | null>;
  /** wallet → KycEntry exists (one getMultipleAccounts per 100 wallets); empty without a registry. */
  passports(wallets: string[]): Promise<Map<string, boolean>>;
}

const FIN = { commitment: "finalized" as const };

export class SimChainOps implements ChainOps {
  constructor(
    private readonly exec: TxExecutor,
    private readonly m: MarketAddrs,
  ) {}

  private get rpc(): ChainRpc {
    return this.exec.rpc;
  }

  private meta(u: UserState): OwnerMeta {
    return { cohort: u.plan.cohort, wave: u.plan.wave };
  }

  now(): Promise<bigint> {
    return chainNow(this.rpc);
  }

  async buy(u: UserState, signer: KeyPairSigner, sale: Address, amount: bigint, terms: SaleDocumentTerms): Promise<string | null> {
    if (this.exec.landed(u, "buy")) return u.tx.buy.sig;
    const account = await fetchSale(this.rpc, sale, FIN);
    const built = await buildDocumentedPurchase(this.rpc, { buyer: signer, sale: account.data, amount, terms });
    if (built.preparationInstructions.length) {
      await this.exec.run(u, this.meta(u), "buy.prep", signer, async () => built.preparationInstructions);
    }
    const { signature } = await this.exec.run(u, this.meta(u), "buy", signer, async () => built.purchaseInstructions);
    return signature;
  }

  async offerPda(offerId: bigint): Promise<Address> {
    return findOfferPda(this.m.classA, offerId);
  }

  async offer(pda: Address): Promise<OfferView | null> {
    const account = await fetchMaybeOffer(this.rpc, pda, FIN);
    if (!account.exists) return null;
    return { status: account.data.status, deposited: account.data.deposited, expiresAt: account.data.expiresAt, maker: account.data.maker };
  }

  async createOffer(u: UserState, signer: KeyPairSigner, key: string, offer: OfferRecord): Promise<void> {
    await this.exec.run(
      u,
      this.meta(u),
      `${key}.create`,
      signer,
      async () => [
        await getCreateOfferInstructionAsync({
          maker: signer,
          shareClass: this.m.classA,
          mint: this.m.mintA,
          paymentMint: this.m.paymentMint,
          tokenProgram: TOKEN_2022,
          offerId: BigInt(offer.offerId),
          amount: BigInt(offer.amount),
          price: BigInt(offer.price),
          expiresAt: BigInt(offer.expiresAt),
        }),
      ],
      { done: async () => (await this.offer(offer.pda as Address)) !== null },
    );
  }

  async depositOffer(u: UserState, signer: KeyPairSigner, key: string, offer: OfferRecord): Promise<void> {
    const pda = offer.pda as Address;
    await this.exec.run(
      u,
      this.meta(u),
      `${key}.deposit`,
      signer,
      async () => {
        const account = await fetchOffer(this.rpc, pda, FIN);
        const [makerShareAta] = await findAssociatedTokenPda({ owner: signer.address, tokenProgram: TOKEN_2022, mint: account.data.mint });
        const [platform] = await findPlatformPda();
        const base = getDepositToOfferEscrowInstruction({
          platform,
          maker: signer,
          offer: pda,
          mint: account.data.mint,
          escrow: account.data.escrow,
          makerShareAccount: makerShareAta,
          tokenProgram: TOKEN_2022,
          amount: BigInt(offer.amount),
        });
        // Funding leg (maker → offer escrow) carries the hook tail, as in /portfolio/offers.
        const tail = await hookTransferMetas(this.rpc, account.data.mint, {
          sourceTokenAccount: makerShareAta,
          destTokenAccount: account.data.escrow,
          transferAuthority: signer.address,
          sourceOwner: signer.address,
          destOwner: pda,
        });
        return [{ ...base, accounts: [...base.accounts, ...tail] }];
      },
      { done: async () => ((await this.offer(pda))?.deposited ?? BigInt(0)) >= BigInt(offer.amount) },
    );
  }

  /** Refund leg (offer escrow → maker) shared by cancel and expire. */
  private async refundIxs(signer: KeyPairSigner, pda: Address, kind: "cancel" | "expire"): Promise<Instruction[]> {
    const account = await fetchOffer(this.rpc, pda, FIN);
    const maker = account.data.maker;
    const [makerShareAta] = await findAssociatedTokenPda({ owner: maker, tokenProgram: TOKEN_2022, mint: account.data.mint });
    const createAta = await getCreateAssociatedTokenIdempotentInstructionAsync({
      payer: signer,
      owner: maker,
      mint: account.data.mint,
      tokenProgram: TOKEN_2022,
    });
    const common = {
      offer: pda,
      mint: account.data.mint,
      escrow: account.data.escrow,
      makerShareAccount: makerShareAta,
      shareTokenProgram: TOKEN_2022,
    };
    const base =
      kind === "cancel"
        ? await getCancelOfferInstructionAsync({ maker: signer, ...common })
        : await getExpireOfferInstructionAsync({ payer: signer, ...common });
    const tail = await hookTransferMetas(this.rpc, account.data.mint, {
      sourceTokenAccount: account.data.escrow,
      destTokenAccount: makerShareAta,
      transferAuthority: pda,
      sourceOwner: pda,
      destOwner: maker,
    });
    return [createAta, { ...base, accounts: [...base.accounts, ...tail] }];
  }

  async cancelOffer(u: UserState, signer: KeyPairSigner, key: string, offer: OfferRecord): Promise<void> {
    const pda = offer.pda as Address;
    await this.exec.run(u, this.meta(u), `${key}.cancel`, signer, () => this.refundIxs(signer, pda, "cancel"), {
      done: async () => (await this.offer(pda))?.status === OfferStatus.Cancelled,
    });
  }

  async expireOffer(u: UserState, signer: KeyPairSigner, key: string, offerPda: Address): Promise<void> {
    await this.exec.run(u, this.meta(u), `${key}.expire`, signer, () => this.refundIxs(signer, offerPda, "expire"), {
      done: async () => (await this.offer(offerPda))?.status === OfferStatus.Expired,
    });
  }

  async takeOffer(u: UserState, signer: KeyPairSigner, key: string, offerPda: Address): Promise<void> {
    await this.exec.run(
      u,
      this.meta(u),
      `${key}.take`,
      signer,
      async () => {
        const account = await fetchOffer(this.rpc, offerPda, FIN);
        const paymentTokenProgram = await fetchPlainPaymentMintTokenProgram(this.rpc, account.data.paymentMint, FIN);
        return buildTakeOfferInstructions(this.rpc, { taker: signer, offerPda, offer: account.data, paymentTokenProgram });
      },
      { done: async () => (await this.offer(offerPda))?.status === OfferStatus.Filled },
    );
  }

  async registerIssuer(u: UserState, signer: KeyPairSigner, legalId: string, jurisdiction: number): Promise<Address> {
    const [issuer] = await findIssuerPda({ legalEntityId: toBytes32(legalId) });
    // Copies /issuer/onboarding: zero kybDocHash, the authority pays.
    await this.exec.run(
      u,
      this.meta(u),
      "issuer.register",
      signer,
      async () => [
        await getRegisterIssuerInstructionAsync({
          authority: signer,
          legalEntityId: toBytes32(legalId),
          jurisdiction,
          kybDocHash: new Uint8Array(32),
        }),
      ],
      {
        done: async () =>
          (await this.rpc.getAccountInfo(issuer, { encoding: "base64", ...FIN, dataSlice: { offset: 0, length: 0 } }).send()).value !== null,
      },
    );
    return issuer;
  }

  async deal(pda: Address): Promise<DealView | null> {
    const account = await fetchMaybeOtcDeal(this.rpc, pda, FIN);
    if (!account.exists) return null;
    const d = account.data;
    return { status: d.status, assetDeposited: d.assetDeposited, paymentDeposited: d.paymentDeposited, seller: d.seller, buyer: d.buyer };
  }

  async depositDealAsset(u: UserState, signer: KeyPairSigner, dealPda: Address): Promise<void> {
    await this.exec.run(
      u,
      this.meta(u),
      "deal.depositAsset",
      signer,
      async () => {
        const deal = (await fetchOtcDeal(this.rpc, dealPda, FIN)).data;
        const paymentTokenProgram = await fetchPlainPaymentMintTokenProgram(this.rpc, deal.paymentMint, FIN);
        return buildDepositOtcAssetInstructions(this.rpc, { seller: signer, dealPda, deal, paymentTokenProgram });
      },
      { done: async () => Boolean((await this.deal(dealPda))?.assetDeposited) || (await this.deal(dealPda))?.status === OtcDealStatus.Completed },
    );
  }

  async depositDealPayment(u: UserState, signer: KeyPairSigner, dealPda: Address): Promise<void> {
    await this.exec.run(
      u,
      this.meta(u),
      "deal.depositPayment",
      signer,
      async () => {
        const deal = (await fetchOtcDeal(this.rpc, dealPda, FIN)).data;
        const payProgram = await fetchPlainPaymentMintTokenProgram(this.rpc, deal.paymentMint, FIN);
        const wallet = signer.address;
        const [buyerPaymentAta] = await findAssociatedTokenPda({ owner: wallet, tokenProgram: payProgram, mint: deal.paymentMint });
        const [buyerShareAta] = await findAssociatedTokenPda({ owner: wallet, tokenProgram: TOKEN_2022, mint: deal.mint });
        const [sellerPaymentAta] = await findAssociatedTokenPda({ owner: deal.seller, tokenProgram: payProgram, mint: deal.paymentMint });
        // As /portfolio/deals: both settlement destinations exist first.
        const createBuyerShare = await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: signer, owner: wallet, mint: deal.mint, tokenProgram: TOKEN_2022 });
        const createSellerPayment = await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: signer, owner: deal.seller, mint: deal.paymentMint, tokenProgram: payProgram });
        const base = await getDepositOtcPaymentInstructionAsync({
          buyer: signer,
          deal: dealPda,
          mint: deal.mint,
          paymentMint: deal.paymentMint,
          buyerPaymentAccount: buyerPaymentAta,
          paymentEscrow: deal.paymentEscrow,
          assetEscrow: deal.assetEscrow,
          buyerShareAccount: buyerShareAta,
          sellerPaymentAccount: sellerPaymentAta,
          shareTokenProgram: TOKEN_2022,
          paymentTokenProgram: payProgram,
        });
        const tail = await hookTransferMetas(this.rpc, deal.mint, {
          sourceTokenAccount: deal.assetEscrow,
          destTokenAccount: buyerShareAta,
          transferAuthority: dealPda,
          sourceOwner: dealPda,
          destOwner: wallet,
        });
        return [createBuyerShare, createSellerPayment, { ...base, accounts: [...base.accounts, ...tail] }];
      },
      { done: async () => Boolean((await this.deal(dealPda))?.paymentDeposited) || (await this.deal(dealPda))?.status === OtcDealStatus.Completed },
    );
  }

  async passports(wallets: string[]): Promise<Map<string, boolean>> {
    const out = new Map<string, boolean>();
    if (!this.m.kycRegistry || wallets.length === 0) return out;
    for (let i = 0; i < wallets.length; i += 100) {
      const batch = wallets.slice(i, i + 100);
      const entries = await Promise.all(batch.map((w) => getEntryPda(this.m.kycRegistry!, w as Address)));
      const { value } = await this.rpc
        .getMultipleAccounts(entries, { encoding: "base64", ...FIN, dataSlice: { offset: 0, length: 0 } })
        .send();
      batch.forEach((w, j) => out.set(w, value[j] !== null));
    }
    return out;
  }
}
