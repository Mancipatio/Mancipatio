// The v1.0.0-rc (8.3) gate accounts, read BEFORE a wallet signs.
//
// The program appends two kinds of gate accounts to the instructions that
// move money to an issuer or between parties, and requires each to be the
// canonical address and UNSET (no account there):
//   * `issuer_freeze` ["issuer_freeze", issuer] — D1, else IssuerProceedsFrozen
//     (6143): open_sale, buy, close_sale, open_payout_vault, release_payout,
//     claim_founder_yield;
//   * `*_block_entry` ["blocked", wallet] under the transfer hook — else
//     PartyBlocklisted (6144): the buyer, the taker and maker, the OTC
//     parties, the issuer key and the payees.
// The builders already name these accounts, so this reads them (one
// getMultipleAccounts at `confirmed`) and refuses with the program's words
// before any wallet prompt — the user never signs (or pays rent for a
// preparation step of) a transaction that must fail. Like the pause gate it
// is a display gate and fails OPEN: a failed read lets the transaction go on
// to the program, which is the authority.
//
// Called for every wallet transaction from lib/verified-solana-client.ts
// (next to the pause gate); a page that sends a preparation transaction first
// (the sale page's token accounts) calls it on the main instructions before
// that. GATE_ACCOUNTS indices are pinned to the IDL by
// tests/proceeds-gate.test.ts.
import { fetchEncodedAccounts, type Address } from "@solana/kit";
import {
  ASSET_REGISTRY_PROGRAM_ADDRESS,
  AssetRegistryInstruction,
  identifyAssetRegistryInstruction,
} from "@/lib/generated/asset_registry";
import { ISSUER_PROCEEDS_FROZEN_HINT, PARTY_BLOCKLISTED_HINT } from "@/lib/tx-error";

const Ix = AssetRegistryInstruction;
export type GateKind = "freeze" | "block";

/** Instruction → the IDL index of each gate account it carries (must be unset). */
export const GATE_ACCOUNTS: ReadonlyMap<AssetRegistryInstruction, readonly { index: number; kind: GateKind }[]> = new Map([
  [Ix.OpenSale, [{ index: 14, kind: "freeze" }]],
  [Ix.Buy, [{ index: 13, kind: "block" }, { index: 14, kind: "freeze" }]],
  [Ix.CloseSale, [{ index: 9, kind: "freeze" }, { index: 10, kind: "block" }, { index: 11, kind: "block" }]],
  [Ix.OpenPayoutVault, [{ index: 10, kind: "freeze" }]],
  [Ix.ReleasePayout, [{ index: 8, kind: "freeze" }, { index: 9, kind: "block" }]],
  [Ix.ClaimFounderYield, [{ index: 9, kind: "freeze" }, { index: 10, kind: "block" }]],
  [Ix.TakeOffer, [{ index: 12, kind: "block" }, { index: 13, kind: "block" }]],
  [Ix.DepositOtcAsset, [{ index: 13, kind: "block" }, { index: 14, kind: "block" }]],
  [Ix.DepositOtcPayment, [{ index: 13, kind: "block" }, { index: 14, kind: "block" }]],
  [Ix.ExpireOtcDeal, [{ index: 11, kind: "block" }, { index: 12, kind: "block" }]],
  [Ix.ClaimVested, [{ index: 7, kind: "block" }]],
  [Ix.PushVested, [{ index: 7, kind: "block" }]],
  [Ix.ProposeIssuerAuthority, [{ index: 4, kind: "block" }]],
  [Ix.AcceptIssuerAuthority, [{ index: 9, kind: "block" }]],
]);

type InstructionLike = {
  programAddress: Address | string;
  data?: Uint8Array | ArrayLike<number>;
  accounts?: readonly { address: Address | string }[];
};

/** Thrown before any wallet prompt when a gate account is set (the program would refuse). */
export class GateAccountSetError extends Error {
  readonly kind: GateKind;
  readonly instruction: AssetRegistryInstruction;
  readonly account: string;
  constructor(kind: GateKind, instruction: AssetRegistryInstruction, account: string) {
    super(`${kind === "freeze" ? ISSUER_PROCEEDS_FROZEN_HINT : PARTY_BLOCKLISTED_HINT} Nothing was sent to your wallet.`);
    this.name = "GateAccountSetError";
    this.kind = kind;
    this.instruction = instruction;
    this.account = account;
  }
}

/** Pure: every gate account the instructions name, with what it gates. */
export function gateAccountsOf(
  instructions: readonly InstructionLike[],
): { address: string; kind: GateKind; instruction: AssetRegistryInstruction }[] {
  const out: { address: string; kind: GateKind; instruction: AssetRegistryInstruction }[] = [];
  for (const ix of instructions) {
    if (ix.programAddress !== ASSET_REGISTRY_PROGRAM_ADDRESS || !ix.data || !ix.accounts) continue;
    let instruction: AssetRegistryInstruction;
    try {
      instruction = identifyAssetRegistryInstruction(ix.data instanceof Uint8Array ? ix.data : Uint8Array.from(ix.data));
    } catch {
      continue; // Not an instruction of this program version: the program decides.
    }
    for (const gate of GATE_ACCOUNTS.get(instruction) ?? []) {
      const address = ix.accounts[gate.index]?.address;
      if (address && !out.some((g) => g.address === address)) out.push({ address: String(address), kind: gate.kind, instruction });
    }
  }
  return out;
}

type AccountReader = (addresses: string[]) => Promise<readonly boolean[]>;

async function readExists(rpc: unknown, addresses: string[]): Promise<boolean[]> {
  const accounts = await fetchEncodedAccounts(rpc as Parameters<typeof fetchEncodedAccounts>[0], addresses as Address[], {
    commitment: "confirmed",
    abortSignal: AbortSignal.timeout(5_000),
  });
  return accounts.map((a) => a.exists);
}

/**
 * Throws GateAccountSetError when a gate account of `instructions` exists
 * (the issuer is frozen, or a party is blocklisted); resolves otherwise,
 * including when the accounts could not be read (fail open). A freeze is
 * reported before a block.
 */
export async function assertGateAccountsUnset(
  rpc: unknown,
  instructions: readonly InstructionLike[],
  opts: { read?: AccountReader } = {},
): Promise<void> {
  const gates = gateAccountsOf(instructions);
  if (gates.length === 0) return;
  let exists: readonly boolean[];
  try {
    exists = await (opts.read ?? ((addresses) => readExists(rpc, addresses)))(gates.map((g) => g.address));
  } catch {
    return;
  }
  const set = gates.filter((_, i) => exists[i]);
  const hit = set.find((g) => g.kind === "freeze") ?? set[0];
  if (hit) throw new GateAccountSetError(hit.kind, hit.instruction, hit.address);
}
