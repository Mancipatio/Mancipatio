/**
 * Fixed inputs of the 100-user devnet simulator (docs/mainnet-readiness/sim,
 * design-sim.md). Every value here is public: addresses, the site origin and
 * the pacing limits the owner approved on 25.9.
 */
import type { Address } from "@solana/kit";

/** The one site the simulator may talk to: exactly this origin (not the apex, not a preview). */
export const SITE_ORIGIN = "https://www.manci.io";
export const SIM_NETWORK = "devnet" as const;

/** Deployer key (~/.config/solana/id-devnet.json): pays the SOL funding only. */
export const DEPLOYER = "3E8ZZJBkz82RmLSSmMZJBGuwrtkJDoCsX5UZVj26rqBr" as Address;
/**
 * CLI Admin (~/.config/solana/manci-e2e-admin.json): the e2e issuer and the
 * mint authority of the e2e payment mint. Loaded only for the market setup
 * (approve/open sale, listing) and for minting payment tokens.
 */
export const CLI_ADMIN = "CekAgg4nCW8tgUETKstwBxKXcWDC5SFRTaZPyQ1vM8vA" as Address;
/** The e2e classic test payment mint (6 decimals, mint authority CLI_ADMIN). */
export const E2E_PAYMENT_MINT = "6bJVcLbqrDFRAny97ppSKou8BrtAynegb2Wo45j3MQaM" as Address;
export const E2E_RUN_ID = "42eac4";

export const PAYMENT_DECIMALS = 6;
export const PAYMENT_UNIT = BigInt(10 ** PAYMENT_DECIMALS);
/** Payment tokens each buyer receives (500.000000). */
export const BUYER_PAYMENT = BigInt(500) * PAYMENT_UNIT;
/** Units per simulator sale and the sale price (1.000000 per unit). */
export const SALE_UNITS = BigInt(3_000);
export const SALE_PRICE = PAYMENT_UNIT;
/** Simulator sales stay open 72 h (design §1 "Market setup"). */
export const SALE_OPEN_SECONDS = BigInt(72 * 3_600);
export const ONE_DAY = BigInt(86_400);

/** SOL each cohort receives from the deployer (lamports). */
export const LAMPORTS_PER_SOL = BigInt(1_000_000_000);
export const SOL_BUYER = BigInt(30_000_000); // 0.03 SOL: I, T and X
export const SOL_ISSUER = BigInt(20_000_000); // 0.02 SOL: B companies (register_issuer)

/**
 * Cohort X (design-transfers.md): class A units a pair moves. The hub gets
 * XFER_UNITS (a loan from e2e buyer3, or its own buy), sends XFER_PEER_UNITS
 * to its peer, and pair 1 puts XFER_OFFER_UNITS of the P2P units in an offer.
 */
export const XFER_UNITS = BigInt(3);
export const XFER_PEER_UNITS = BigInt(2);
export const XFER_OFFER_UNITS = BigInt(1);
/**
 * The devnet platform KYC registry (authority: the owner's wallet). Only the
 * B4 probe names it, as the registry of a KycGated-shaped tail on an Open
 * mint; any registry address gives the same result there.
 */
export const DEVNET_PLATFORM_KYC_REGISTRY = "5MofiJNCoCRkNg1f2Yd7368WkjiNxkZZmUTaQo7xLhku" as Address;
/** System transfers per funding transaction (fits one packet with margin). */
export const FUND_BATCH = 16;
/** Payment-token owners per mint transaction (ATA create + mint each). */
export const MINT_BATCH = 4;

/** Owner decisions of 25.9. (pacing: the simulator shares the owner's IP). */
export const PACE = {
  httpConcurrency: 2,
  writeIntervalMs: 8_000,
  uploadsPerMin: 10,
  verificationPerMin: 5,
  readsPerMin: 15,
  txPerMin: 3,
  /** Transfer probes: simulated only (never sent), still paced. */
  probesPerMin: 6,
  chainRps: 1,
  watchIntervalMs: 120_000,
} as const;

/** Upload limits of POST /api/clients/upload and the Vercel body cap. */
export const UPLOAD_MAX_BYTES = 15 * 1024 * 1024;
export const VERCEL_BODY_CAP = Math.floor(4.5 * 1024 * 1024);
export const DOC_MIN_BYTES = 20 * 1024;
export const DOC_MAX_BYTES = 150 * 1024;

/** The watermark every simulated document carries. */
export const WATERMARK = "TEST DOCUMENT – NOT A REAL ID";
export const WATERMARK_ASCII = "TEST DOCUMENT - NOT A REAL ID";
