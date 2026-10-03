/**
 * Tool 9: `chain:direct-buy` — a DEVNET-ONLY test tool for the off-platform
 * buy alarm (#58, D2: lib/server/onchain-link-check.ts). It buys `units` of
 * an Open sale by calling the program directly with a test key, exactly as a
 * script that never touches the site would: no sign-in (SIWS), no Terms
 * acceptance, no sanctions pre-check, no purchase record. The alarm worker
 * should then open one `onchain:unlinked-buy` compliance alert for the buyer
 * about LINK_GRACE_MS (2 minutes) after the buy's block time
 * (ops/runbook-mainnet.md §15, "Devnet verification of the off-platform buy
 * alarm").
 *
 * The instructions are the site's own (lib/purchase-builder): the buyer's two
 * idempotent token-account creations, then `buy` with its gate accounts and
 * the receiver tail. With CHAIN_BUY_TERMS (the JSON of
 * GET /api/launchpad/terms?sale=<sale>, saved to a file: the tool reaches no
 * host but the RPC) the document-acceptance memo rides along exactly as on
 * the sale page (buildDocumentedPurchase); without it the buy is sent bare
 * (buildSaleBuy), as a script would.
 *
 * Gates: CHAIN_NETWORK must be devnet (readChainConfig refuses every other
 * cluster before CHAIN_ALLOW_MAINNET is read: DEVNET_ONLY_TOOLS), the RPC is
 * pinned to the devnet genesis, a dry run is the default (it probes, builds,
 * simulates and prints the plan digest), and a send needs CHAIN_SEND=1,
 * CHAIN_CONFIRM_PLAN=<digest> and CHAIN_KEYPAIR (the test key; it must be
 * CHAIN_BUY_BUYER). The send re-probes, rebuilds with the key, checks the
 * digest again and goes through the same journal → simulate → send →
 * finalize pipeline as the other tools.
 *
 * Inputs: CHAIN_BUY_SALE (the sale PDA), CHAIN_BUY_UNITS (share-class units,
 * a positive integer), CHAIN_BUY_BUYER (the test key's address, typed out),
 * CHAIN_BUY_TERMS (optional, see above).
 */
import fs from "node:fs";
import { createNoopSigner, isAddress, type Address, type Instruction, type TransactionSigner } from "@solana/kit";
import {
  ASSET_REGISTRY_PROGRAM_ADDRESS,
  SaleStatus,
  fetchMaybeSale,
  type Sale,
} from "@/lib/generated/asset_registry";
import type { SaleDocumentTerms } from "@/lib/document-terms";
import { findSalePda } from "@/lib/pdas";
import { buildDocumentedPurchase, buildSaleBuy, planDocumentedPurchase } from "@/lib/purchase-builder";
import type { ToolContext, ToolStatus } from "./context";
import { ChainGateError, ChainPlanError, loadHotSigner } from "./safety";
import {
  MAX_COMPUTE_UNITS,
  buildMessage,
  executePlan,
  planDigest,
  simulateUnsigned,
  summarizeSimulation,
  type PlanStep,
  type StepRecord,
} from "./tx";

const U64_MAX = (BigInt(1) << BigInt(64)) - BigInt(1);

export type DirectBuyRequest = { sale: Address; units: bigint; buyer: Address; termsFile: string | null };

/** Reads CHAIN_BUY_SALE, CHAIN_BUY_UNITS, CHAIN_BUY_BUYER and CHAIN_BUY_TERMS. */
export function readDirectBuyRequest(env: ToolContext["env"]): DirectBuyRequest {
  const sale = env.CHAIN_BUY_SALE?.trim();
  if (!sale || !isAddress(sale)) throw new ChainGateError("CHAIN_BUY_SALE must be the sale's address");
  const raw = env.CHAIN_BUY_UNITS?.trim() ?? "";
  if (!/^[1-9]\d{0,19}$/.test(raw) || BigInt(raw) > U64_MAX) {
    throw new ChainGateError("CHAIN_BUY_UNITS must be a positive whole number of share-class units");
  }
  const buyer = env.CHAIN_BUY_BUYER?.trim();
  if (!buyer || !isAddress(buyer) || buyer === "11111111111111111111111111111111") {
    throw new ChainGateError("CHAIN_BUY_BUYER must be the test key's address (typed out)");
  }
  const termsFile = env.CHAIN_BUY_TERMS?.trim() || null;
  return { sale, units: BigInt(raw), buyer, termsFile };
}

/** The sale page's terms JSON (`{ ok, data }` or the data itself), checked for this sale. Errors never echo the path. */
export function readTermsFile(file: string, sale: Address): SaleDocumentTerms {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    throw new ChainGateError("CHAIN_BUY_TERMS is not a readable JSON file (path withheld)");
  }
  const data = (parsed && typeof parsed === "object" && "data" in parsed ? (parsed as { data: unknown }).data : parsed) as Record<string, unknown> | null;
  if (
    !data ||
    typeof data.versionId !== "string" ||
    typeof data.sha256 !== "string" ||
    typeof data.sale !== "string" ||
    typeof data.asset !== "string" ||
    typeof data.url !== "string" ||
    typeof data.verifiedAt !== "string"
  ) {
    throw new ChainGateError("CHAIN_BUY_TERMS must hold the JSON of GET /api/launchpad/terms?sale=<sale>");
  }
  if (data.sale !== sale) throw new ChainGateError("CHAIN_BUY_TERMS belongs to another sale");
  return data as unknown as SaleDocumentTerms;
}

/** What the plan's preconditions read from chain. */
export type DirectBuyState = { exists: boolean; open: boolean; remaining: bigint; endTs: bigint; startTs: bigint };

export async function probeSale(ctx: ToolContext, sale: Address): Promise<{ state: DirectBuyState; data: Sale | null }> {
  const account = await fetchMaybeSale(ctx.rpc, sale, { commitment: "finalized" });
  if (!account.exists) return { state: { exists: false, open: false, remaining: BigInt(0), endTs: BigInt(0), startTs: BigInt(0) }, data: null };
  if (account.programAddress !== ASSET_REGISTRY_PROGRAM_ADDRESS) throw new ChainPlanError("CHAIN_BUY_SALE is not an asset_registry account");
  const d = account.data;
  return {
    state: { exists: true, open: d.status === SaleStatus.Open, remaining: d.totalForSale - d.sold, endTs: d.endTs, startTs: d.startTs },
    data: d,
  };
}

/** The steps (prep only when the token accounts do not fit with the buy) built by the site's own builder. */
export async function directBuySteps(
  ctx: ToolContext,
  input: { buyer: TransactionSigner; sale: Sale; units: bigint; terms: SaleDocumentTerms | null },
): Promise<PlanStep<DirectBuyState>[]> {
  const rpc = ctx.rpc as unknown as Parameters<typeof buildSaleBuy>[0];
  const plan = input.terms
    ? await buildDocumentedPurchase(rpc, { buyer: input.buyer, sale: input.sale, amount: input.units, terms: input.terms })
    : await (async () => {
        const built = await buildSaleBuy(rpc, { buyer: input.buyer, sale: input.sale, amount: input.units });
        return planDocumentedPurchase(built.preparation, [built.buy], input.buyer);
      })();
  const open = { label: "the sale is Open", holds: (s: DirectBuyState) => s.exists && s.open };
  const room = { label: `at least ${input.units} units remain`, holds: (s: DirectBuyState) => s.remaining >= input.units };
  const steps: PlanStep<DirectBuyState>[] = [];
  if (plan.preparationInstructions.length) {
    steps.push({
      id: "prepare",
      title: "create the buyer's token accounts (idempotent)",
      signer: input.buyer,
      signerRole: "test buyer",
      ixs: plan.preparationInstructions as Instruction[],
      preconditions: [open],
      simulate: "now",
      idempotency: "replay-safe",
      required: "confirmed",
    });
  }
  steps.push({
    id: "buy",
    title: `buy ${input.units} units directly (no site, no Terms)`,
    signer: input.buyer,
    signerRole: "test buyer",
    ixs: plan.purchaseInstructions as Instruction[],
    preconditions: [open, room],
    // After a separate preparation the buy can only be simulated once the accounts exist.
    simulate: plan.preparationInstructions.length ? "at-send" : "now",
    idempotency: "non-idempotent",
    // The indexer and the alarm worker act on finalized transactions.
    required: "finalized",
  });
  return steps;
}

export async function directBuyTool(ctx: ToolContext): Promise<ToolStatus> {
  const { config, evidence } = ctx;
  ctx.phase = "inputs";
  // readChainConfig refused every other cluster already; this tool never trusts one check.
  if (config.network !== "devnet") throw new ChainGateError("chain:direct-buy runs on devnet only");
  const req = readDirectBuyRequest(ctx.env);
  const terms = req.termsFile ? readTermsFile(req.termsFile, req.sale) : null;
  evidence.request = { sale: req.sale, units: req.units.toString(), buyer: req.buyer, documentMemo: terms !== null };

  ctx.phase = "probe";
  const probed = await probeSale(ctx, req.sale);
  if (!probed.data) throw new ChainPlanError("No sale account at CHAIN_BUY_SALE on devnet");
  const sale = probed.data;
  if ((await findSalePda(sale.shareClass, sale.saleId)) !== req.sale) throw new ChainPlanError("CHAIN_BUY_SALE is not the sale PDA of its share class and id");
  if (!probed.state.open) throw new ChainPlanError("The sale is not Open");
  if (probed.state.remaining < req.units) throw new ChainPlanError(`Only ${probed.state.remaining} units remain in this sale`);
  const cost = sale.pricePerUnit * req.units;
  evidence.sale = {
    shareClass: sale.shareClass, mint: sale.mint, paymentMint: sale.paymentMint, pricePerUnit: sale.pricePerUnit.toString(),
    remaining: probed.state.remaining.toString(), costBaseUnits: cost.toString(),
  };
  ctx.log(`sale      ${req.sale} (Open, ${probed.state.remaining} units left)`);
  ctx.log(`buy       ${req.units} units for ${cost} base units of ${sale.paymentMint}`);
  ctx.log(`buyer     ${req.buyer} (test key; never signed in, no Terms accepted)`);

  ctx.phase = "plan";
  const draft = await directBuySteps(ctx, { buyer: createNoopSigner(req.buyer), sale, units: req.units, terms });
  const digestOf = (steps: PlanStep<DirectBuyState>[]) =>
    planDigest({ network: config.network, genesis: config.expectedGenesis, roleMapSha256: null, releaseSha256Sums: null, steps });
  const digest = digestOf(draft);
  evidence.planDigest = digest;
  evidence.plan = draft.map((s) => ({ id: s.id, title: s.title, preconditions: s.preconditions.map((p) => p.label) }));

  if (!config.send) {
    ctx.phase = "simulate";
    const simulations: Record<string, string> = {};
    for (const step of draft) {
      if (step.simulate !== "now") {
        simulations[step.id] = "simulated at send (after the token accounts exist)";
        ctx.log(`${step.id.padEnd(9)} ${step.title}  [simulated at send]`);
        continue;
      }
      const blockhash = (await ctx.rpc.getLatestBlockhash({ commitment: "confirmed" }).send()).value;
      const result = await simulateUnsigned(
        ctx.rpc,
        buildMessage({ feePayer: step.signer, ixs: step.ixs, blockhash, cuLimit: MAX_COMPUTE_UNITS, cuPrice: config.cuPrice }),
      );
      const text = result.ok ? `simulated ok, ${result.unitsConsumed ?? "?"} CU` : `SIMULATION FAILED ${summarizeSimulation(result)}`;
      simulations[step.id] = text;
      ctx.log(`${step.id.padEnd(9)} ${step.title}  [${text}]`);
      if (!result.ok) {
        evidence.simulation = simulations;
        throw new ChainPlanError(`the ${step.id} transaction failed simulation (does the test key hold SOL and ${cost} base units of the payment mint?)`);
      }
    }
    evidence.simulation = simulations;
    ctx.log(`plan digest: ${digest}`);
    ctx.log("dry run: nothing sent. Send with CHAIN_SEND=1 CHAIN_CONFIRM_PLAN=<digest> CHAIN_KEYPAIR=<the test key file>.");
    return "awaiting";
  }
  if (config.confirmPlan !== digest) throw new ChainPlanError("CHAIN_CONFIRM_PLAN does not match the recomputed plan digest");

  ctx.phase = "signer";
  const signer = await loadHotSigner(config.keypairPath!, req.buyer, "test buyer");
  const steps = await directBuySteps(ctx, { buyer: signer, sale, units: req.units, terms });
  if (digestOf(steps) !== digest) throw new ChainPlanError("the plan changed while the key was loaded; run the dry run again");

  ctx.phase = "send";
  const journal = ctx.beginSend();
  journal.append({ event: "plan", digest, steps: steps.map((s) => s.id) });
  const records: StepRecord[] = [];
  evidence.steps = records;
  await executePlan(steps, {
    rpc: ctx.rpc,
    drainRpc: ctx.drainRpc,
    journal,
    cuPrice: config.cuPrice,
    signal: ctx.signal,
    timing: ctx.timing,
    log: ctx.log,
    records,
    probe: async () => (await probeSale(ctx, req.sale)).state,
  });
  const bought = records.find((r) => r.id === "buy");
  if (bought?.signature) {
    evidence.buySignature = bought.signature;
    ctx.log(`bought: ${bought.signature}`);
    ctx.log("next: about 2 minutes after this buy finalizes, the alarm worker opens an onchain:unlinked-buy alert for the buyer (/admin/compliance; runbook §15, devnet verification).");
  }
  return "completed";
}
