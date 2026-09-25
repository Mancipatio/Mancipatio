/**
 * One-time market setup and per-wave funding (design-sim §1 "Market setup",
 * §3), as the CLI Admin (the e2e issuer of MANCI-E2E-42eac4) and the deployer:
 *
 * - the e2e addresses come from docs/mainnet-readiness/e2e-6.3/devnet/state.json
 *   and are checked on chain (issuer KYB Verified, authority = CLI Admin,
 *   payment mint = the e2e test mint);
 * - two fresh sales on class A (3,000 units at 1.000000, open 72 h), each
 *   with an approve_sale covering its gross — the patterns of
 *   scripts/chain/lib/e2e/groups/g1.ts approveSaleIxs / openSaleIxs;
 * - a published launchpad listing per sale (launchpad.listingUpsert);
 * - the terms check: without a published whitepaper the terms route answers
 *   409 and the buyers wait (owner-queue.txt says what to publish);
 * - SOL from the deployer (16 transfers per tx) and payment tokens from the
 *   mint authority (4 owners per tx), only to users that still need them
 *   (cohort X: SOL for all four, payment tokens for the two hubs, which buy
 *   their own units when the donor cannot lend).
 *
 * The devnet faucet is never used.
 */
import fs from "node:fs";
import { isAddress, type Address, type KeyPairSigner } from "@solana/kit";
import {
  KybStatus,
  RaiseType,
  fetchMaybeIssuer,
  fetchMaybeShareClass,
  findSaleApprovalPda,
  getApproveSaleInstructionAsync,
  getOpenSaleInstructionAsync,
} from "@/lib/generated/asset_registry";
import { findKycRegistryPda } from "@/lib/generated/asset_registry";
import { CLUSTER_GENESIS_HASHES } from "@/lib/network-identity";
import { findSalePda } from "@/lib/pdas";
import { TOKEN_CLASSIC } from "@/lib/transaction-builders";
import { chainNow } from "@/scripts/chain/lib/e2e/clock";
import { fundInstructions, mintPaymentInstructions, paymentAta, tokenBalance, topUp } from "@/scripts/chain/lib/e2e/fixtures";
import { sha256Bytes } from "@/scripts/chain/lib/e2e/world";
import type { ChainRpc } from "@/scripts/chain/lib/rpc";
import type { MarketAddrs, OwnerMeta, TxExecutor } from "./chain";
import {
  BUYER_PAYMENT,
  CLI_ADMIN,
  E2E_PAYMENT_MINT,
  FUND_BATCH,
  LAMPORTS_PER_SOL,
  MINT_BATCH,
  ONE_DAY,
  SALE_OPEN_SECONDS,
  SALE_PRICE,
  SALE_UNITS,
  SOL_BUYER,
  SOL_ISSUER,
} from "./constants";
import type { Actor, SimHttp } from "./http";
import type { JournalSink } from "./journal";
import { SimGateError } from "./safety";
import type { SimState, UserState } from "./state";

export type E2eAddrs = MarketAddrs & { kycAuthority: Address | null; runId: string };

/** Reads and validates the e2e run's public addresses (never a key file). */
export function readE2eState(file: string): E2eAddrs {
  if (!fs.existsSync(file)) throw new SimGateError("The e2e devnet state.json is missing (set SIM_E2E_STATE)");
  const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as {
    schema?: string;
    network?: string;
    genesis?: string;
    runId?: string;
    roles?: Record<string, string>;
    entities?: Record<string, string>;
  };
  if (parsed.schema !== "mancipatio-e2e-state-v1" || parsed.network !== "devnet" || parsed.genesis !== CLUSTER_GENESIS_HASHES.devnet) {
    throw new SimGateError("SIM_E2E_STATE is not a devnet e2e state (schema, network or genesis differ)");
  }
  const e = parsed.entities ?? {};
  for (const key of ["issuer", "asset", "classA", "mintA", "paymentMint"]) {
    if (!e[key] || !isAddress(e[key])) throw new SimGateError(`The e2e state has no valid ${key}`);
  }
  if (e.paymentMint !== E2E_PAYMENT_MINT) throw new SimGateError("The e2e payment mint is not the pinned test mint 6bJVc…");
  if (parsed.roles?.admin !== CLI_ADMIN || parsed.roles?.issuer !== CLI_ADMIN) {
    throw new SimGateError("The e2e Admin/issuer is not the pinned CLI Admin CekAgg…");
  }
  const kyc = parsed.roles?.kycAuthority;
  // Cohort X only: class B (probe P7) and e2e buyer3 (the loan's donor); optional.
  const optional = (value: string | undefined) => (value && isAddress(value) ? (value as Address) : null);
  return {
    runId: parsed.runId ?? "",
    issuer: e.issuer as Address,
    asset: e.asset as Address,
    classA: e.classA as Address,
    mintA: e.mintA as Address,
    paymentMint: e.paymentMint as Address,
    kycAuthority: kyc && isAddress(kyc) ? (kyc as Address) : null,
    kycRegistry: null,
    classB: optional(e.classB),
    mintB: optional(e.mintB),
    donor: optional(parsed.roles?.buyer3),
  };
}

/** SIM_KYC_REGISTRY, else the registry the e2e KYC authority created, if it exists on chain. */
export async function resolveKycRegistry(rpc: ChainRpc, configured: string | null, authority: Address | null): Promise<Address | null> {
  const candidate = configured ? (configured as Address) : authority ? (await findKycRegistryPda({ authority }))[0] : null;
  if (!candidate) return null;
  const { value } = await rpc.getAccountInfo(candidate, { encoding: "base64", commitment: "finalized", dataSlice: { offset: 0, length: 0 } }).send();
  return value ? candidate : null;
}

/** Refuses to run on anything but the e2e issuer the CLI Admin controls. */
export async function assertMarket(rpc: ChainRpc, m: E2eAddrs): Promise<void> {
  const issuer = await fetchMaybeIssuer(rpc, m.issuer, { commitment: "finalized" });
  if (!issuer.exists || issuer.data.kybStatus !== KybStatus.Verified) throw new SimGateError("The e2e issuer is missing or not KYB-verified");
  if (issuer.data.authority !== CLI_ADMIN) throw new SimGateError("The e2e issuer's authority is not the CLI Admin");
  const share = await fetchMaybeShareClass(rpc, m.classA, { commitment: "finalized" });
  if (!share.exists || share.data.mint !== m.mintA || share.data.asset !== m.asset) throw new SimGateError("The e2e class A does not match its mint and asset");
  if (m.classB && m.mintB) {
    const b = await fetchMaybeShareClass(rpc, m.classB, { commitment: "finalized" });
    if (!b.exists || b.data.mint !== m.mintB || b.data.asset !== m.asset) throw new SimGateError("The e2e class B does not match its mint and asset");
  }
}

async function exists(rpc: ChainRpc, address: Address): Promise<boolean> {
  const { value } = await rpc.getAccountInfo(address, { encoding: "base64", commitment: "finalized", dataSlice: { offset: 0, length: 0 } }).send();
  return value !== null;
}

/** Two unused sale ids, derived from the run id so a resume finds the same ones. */
async function pickSaleIds(rpc: ChainRpc, m: E2eAddrs, runId: string): Promise<number[]> {
  let base = 9_000 + (parseInt(runId, 36) % 400) * 2;
  for (let i = 0; i < 20; i++, base += 2) {
    const taken = await Promise.all(
      [base, base + 1].map(async (id) => exists(rpc, (await findSaleApprovalPda({ shareClass: m.classA, saleId: BigInt(id) }))[0])),
    );
    if (!taken.some(Boolean)) return [base, base + 1];
  }
  throw new SimGateError("No free simulator sale ids on class A");
}

const ADMIN_META: OwnerMeta = { cohort: "setup", wave: null };

export type SetupDeps = {
  state: SimState;
  exec: TxExecutor;
  rpc: ChainRpc;
  http: SimHttp;
  journal: JournalSink;
  persist: () => void;
  log: (line: string) => void;
};

/** Approve + open the two sales, publish their listings, check the terms. Idempotent. */
export async function ensureMarket(d: SetupDeps, admin: KeyPairSigner, m: E2eAddrs): Promise<void> {
  const market = d.state.market;
  if (!market.saleIds.length) {
    market.saleIds = await pickSaleIds(d.rpc, m, d.state.runId);
    d.persist();
  }
  const now = await chainNow(d.rpc);
  market.approvalExpiresAt ??= (now + ONE_DAY).toString();
  market.saleStart ??= now.toString();
  const start = BigInt(market.saleStart);
  for (const saleId of market.saleIds) {
    const [approval] = await findSaleApprovalPda({ shareClass: m.classA, saleId: BigInt(saleId) });
    const sale = await findSalePda(m.classA, BigInt(saleId));
    await d.exec.run(
      market,
      ADMIN_META,
      `approve.${saleId}`,
      admin,
      async () => [
        await getApproveSaleInstructionAsync({
          authority: admin,
          issuer: m.issuer,
          asset: m.asset,
          shareClass: m.classA,
          paymentMint: m.paymentMint,
          saleId: BigInt(saleId),
          maxGrossRaise: SALE_PRICE * SALE_UNITS,
          minPricePerUnit: SALE_PRICE,
          maxPricePerUnit: SALE_PRICE,
          raiseType: RaiseType.Mature,
          expiresAt: BigInt(market.approvalExpiresAt!),
          applicationHash: sha256Bytes(`manci-sim:${d.state.runId}:approval:${saleId}`),
          cliffMonths: 0,
          vestingMonths: 0,
        }),
      ],
      { done: () => exists(d.rpc, approval) },
    );
    await d.exec.run(
      market,
      ADMIN_META,
      `open.${saleId}`,
      admin,
      async () => [
        await getOpenSaleInstructionAsync({
          authority: admin,
          issuer: m.issuer,
          asset: m.asset,
          shareClass: m.classA,
          mint: m.mintA,
          paymentMint: m.paymentMint,
          paymentTokenProgram: TOKEN_CLASSIC,
          approvedBy: admin.address,
          saleId: BigInt(saleId),
          pricePerUnit: SALE_PRICE,
          totalForSale: SALE_UNITS,
          startTs: start,
          endTs: start + SALE_OPEN_SECONDS,
          raiseType: RaiseType.Mature,
          cliffMonths: 0,
          vestingMonths: 0,
        }),
      ],
      { done: () => exists(d.rpc, sale) },
    );
    if (!market.sales.includes(sale)) market.sales.push(sale);
    d.persist();
  }
  const actor: Actor = { label: "admin", cohort: "setup", wave: null, signer: admin };
  for (const sale of market.sales) {
    if (market.listed[sale]) continue;
    const r = await d.http.signed(actor, {
      step: "launchpad.listingUpsert",
      route: "/api/launchpad/listing-upsert",
      action: "launchpad.listingUpsert",
      params: {
        listing: {
          sale_pubkey: sale,
          is_published: true,
          logo_letter: "S",
          problem: "Manci devnet simulator sale (SIM). A test listing on MANCI-E2E-42eac4 — not a real offering.",
        },
      },
    });
    if (r.outcome === "ok") market.listed[sale] = true;
    d.persist();
  }
  const terms = await d.http.get(actor, { step: "launchpad.terms.setup", route: `/api/launchpad/terms?sale=${market.sales[0]}`, expect: [200, 409] });
  market.termsOk = terms.status === 200;
  // Preflight (design §5.1): without an FX row for the payment mint the ledger holds purchases (fx:missing).
  const fx = await d.http.read<{ payment_mint?: string; kind?: string }[]>(actor, {
    step: "adminConfig.fxRatesRead",
    route: "/api/admin-config/fx-rates",
    action: "adminConfig.fxRatesRead",
    params: {},
    expect: [200, 403],
  });
  market.fxKind = fx.status === 200 && Array.isArray(fx.data) ? (fx.data.find((r) => r.payment_mint === m.paymentMint)?.kind ?? "missing") : "unknown";
  d.persist();
  d.log(
    `market: sales ${market.saleIds.join(", ")} open; listings ${Object.keys(market.listed).length}/2; terms ${market.termsOk ? "published" : "missing (buyers wait; see owner-queue.txt)"}; FX row ${market.fxKind}`,
  );
}

export function solTarget(u: UserState): bigint {
  // Cohort X: 2 ATA rents, the offer and escrow rent (cancel refunds only the marker's) and ~8 fees.
  if (u.plan.cohort === "I" || u.plan.cohort === "T" || u.plan.cohort === "X") return SOL_BUYER;
  if (u.plan.cohort === "B" && u.plan.variant.startsWith("company")) return SOL_ISSUER;
  return BigInt(0);
}

export function needsTokens(u: UserState): boolean {
  return u.plan.cohort === "I" || u.plan.cohort === "T" || u.plan.variant === "xfer-hub" || u.plan.variant === "xfer-buyer";
}

export function chunks<T>(list: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/** SOL (deployer) and payment tokens (mint authority) for the users of this wave. */
export async function fundUsers(d: SetupDeps, signers: { deployer: KeyPairSigner; admin: KeyPairSigner }, m: E2eAddrs, users: UserState[]): Promise<void> {
  const funding = d.state.funding;
  const meta: OwnerMeta = { cohort: "setup", wave: null };
  const sol: { to: Address; lamports: bigint; label: string }[] = [];
  for (const u of users) {
    const target = solTarget(u);
    if (target === BigInt(0) || funding.sol[u.plan.label]) continue;
    const need = await topUp(d.rpc, u.wallet as Address, target);
    if (need) sol.push({ ...need, label: u.plan.label });
    else funding.sol[u.plan.label] = true;
  }
  const total = sol.reduce((s, t) => s + t.lamports, BigInt(0));
  if (total > BigInt(0)) {
    const { value } = await d.rpc.getBalance(signers.deployer.address, { commitment: "confirmed" }).send();
    if (value < total + LAMPORTS_PER_SOL / BigInt(10)) {
      throw new SimGateError(`The deployer holds too little SOL for this wave (needs ${Number(total) / 1e9} SOL + 0.1 margin)`);
    }
  }
  for (const batch of chunks(sol, FUND_BATCH)) {
    funding.batches += 1;
    await d.exec.run(funding, meta, `sol.${funding.batches}`, signers.deployer, async () => fundInstructions(signers.deployer, batch));
    for (const t of batch) funding.sol[t.label] = true;
    d.persist();
  }
  const owners: { owner: Address; label: string }[] = [];
  for (const u of users) {
    if (!needsTokens(u) || funding.tokens[u.plan.label]) continue;
    const balance = await tokenBalance(d.rpc, await paymentAta(u.wallet as Address, m.paymentMint));
    if (balance >= BUYER_PAYMENT / BigInt(2)) funding.tokens[u.plan.label] = true;
    else owners.push({ owner: u.wallet as Address, label: u.plan.label });
  }
  for (const batch of chunks(owners, MINT_BATCH)) {
    funding.batches += 1;
    await d.exec.run(funding, meta, `mint.${funding.batches}`, signers.admin, async () =>
      mintPaymentInstructions({ payer: signers.admin, mintAuthority: signers.admin, mint: m.paymentMint, owners: batch.map((b) => b.owner), amount: BUYER_PAYMENT }),
    );
    for (const b of batch) funding.tokens[b.label] = true;
    d.persist();
  }
  d.persist();
}
