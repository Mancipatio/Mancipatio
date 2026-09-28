// Freeze the proceeds of ONE issuer (D1, v1.0.0-rc): the admin side.
//
// * `freeze_issuer_proceeds(reason_hash)` — any live Admin or the Super Admin
//   creates `IssuerFreeze` at ["issuer_freeze", issuer] (the freezer pays the
//   rent). While it exists `open_sale`, `buy`, `close_sale`,
//   `open_payout_vault`, `release_payout` and `claim_founder_yield` of that
//   issuer fail with IssuerProceedsFrozen (6143). A second freeze of the same
//   issuer fails (the account is in use): it never overwrites the first.
// * `unfreeze_issuer_proceeds()` — the Super Admin only (the same asymmetry as
//   the pause bits); the rent returns to the freezer.
//
// The reason itself stays off chain: the account carries only its SHA-256
// (`reason_hash`), and the audit log keeps the text. `freezeReasonHash` is the
// one hashing rule (UTF-8 of the trimmed text), so an operator can later check
// a case-file reason against the chain (`reasonMatchesHash`). Every PDA comes
// from the generated client; reads are at finalized, owner-checked.
import { type Address, type ReadonlyUint8Array, type TransactionSigner } from "@solana/kit";
import {
  ASSET_REGISTRY_PROGRAM_ADDRESS,
  fetchMaybeAdmin,
  fetchMaybeIssuerFreeze,
  fetchMaybePlatform,
  findAdminRecordPda,
  findIssuerFreezePda,
  findPlatformPda,
  getFreezeIssuerProceedsInstructionAsync,
  getUnfreezeIssuerProceedsInstructionAsync,
} from "@/lib/generated/asset_registry";
import type { fetchMintTokenProgram } from "@/lib/transaction-builders";

type Rpc = Parameters<typeof fetchMintTokenProgram>[0];
const finalized = () => ({ commitment: "finalized" as const, abortSignal: AbortSignal.timeout(10_000) });

export type IssuerFreezeState = {
  address: Address;
  issuer: Address;
  frozenBy: Address;
  /** Chain time of the freeze (unix seconds). */
  frozenAt: bigint;
  reasonHash: ReadonlyUint8Array;
};

/** SHA-256 of the trimmed reason text (UTF-8): the freeze's `reason_hash`. */
export async function freezeReasonHash(reason: string): Promise<Uint8Array> {
  const bytes = new TextEncoder().encode(reason.trim());
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
}

export function hashHex(hash: ReadonlyUint8Array): string {
  return Array.from(hash, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** A freeze made without a reason (all-zero hash, e.g. through the CLI). */
export function isEmptyReasonHash(hash: ReadonlyUint8Array): boolean {
  return hash.every((b) => b === 0);
}

/** Whether `reason` is the text whose hash the freeze carries. */
export async function reasonMatchesHash(reason: string, hash: ReadonlyUint8Array): Promise<boolean> {
  if (!reason.trim()) return false;
  return hashHex(await freezeReasonHash(reason)) === hashHex(hash);
}

/** The issuer's live freeze, or null (read at finalized). */
export async function loadIssuerFreeze(rpc: Rpc, issuer: Address): Promise<IssuerFreezeState | null> {
  const [pda] = await findIssuerFreezePda({ issuer });
  const freeze = await fetchMaybeIssuerFreeze(rpc, pda, finalized());
  if (!freeze.exists) return null;
  if (freeze.programAddress !== ASSET_REGISTRY_PROGRAM_ADDRESS || freeze.data.issuer !== issuer)
    throw new Error("The issuer freeze account is invalid");
  return { address: pda, ...pick(freeze.data) };
}

function pick(d: { issuer: Address; frozenBy: Address; frozenAt: bigint; reasonHash: ReadonlyUint8Array }) {
  return { issuer: d.issuer, frozenBy: d.frozenBy, frozenAt: d.frozenAt, reasonHash: d.reasonHash };
}

export type FreezeRole = { isAdmin: boolean; isSuperAdmin: boolean };

export type FreezeActionGate = {
  /** Null when the button may be pressed, else why not. */
  freeze: string | null;
  unfreeze: string | null;
};

/**
 * Which of the two buttons the connected wallet may press. The program is the
 * authority (the builders re-read the roles and the freeze at finalized);
 * this only keeps a transaction that must fail from being offered.
 */
export function freezeActionGate(role: FreezeRole, frozen: boolean | null): FreezeActionGate {
  const unknown = "Reading the freeze state…";
  return {
    freeze:
      frozen === null
        ? unknown
        : frozen
          ? "The proceeds are already frozen: a second freeze is refused, and the first freezer and reason stay on record."
          : role.isAdmin || role.isSuperAdmin
            ? null
            : "Only a Manci Admin or the Super Admin can freeze an issuer's proceeds.",
    unfreeze:
      frozen === null
        ? unknown
        : !frozen
          ? "The proceeds are not frozen."
          : role.isSuperAdmin
            ? null
            : "Only the Super Admin can lift a freeze (Admins can freeze, not unfreeze).",
  };
}

const utc = (unix: bigint | number) =>
  `${new Date(Number(unix) * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC`;

/** One line for the freeze on record ("Frozen on … by …"). */
export function describeIssuerFreeze(freeze: IssuerFreezeState): string {
  return `Frozen on ${utc(freeze.frozenAt)} by ${freeze.frozenBy}.`;
}

/** The instructions a freeze closes, for the panel and the confirmation. */
export const FROZEN_PATHS = [
  "open_sale and buy (no new money flows in)",
  "close_sale (the issuer cannot withdraw sale proceeds)",
  "open_payout_vault, release_payout and claim_founder_yield (no payout to the founder)",
] as const;

/**
 * What a freeze does NOT stop (design 8.3 §3.2, O-9), and what it locks
 * without an exit (risk 17: disclosed in the Terms, /security and /risks).
 */
export const NOT_FROZEN_PATHS = [
  "the exits of what the issuer does not receive: offer cancels, OTC expiries and Admin cancels, custody returns, investor yield and milestone claims",
  "units the issuer's own wallet already holds: it can still sell them on the secondary market or send them away (O-9)",
] as const;

/** Locked while the freeze lasts, with no refund instruction (design 8.3 risk 17). */
export const FROZEN_SALE_PAYMENTS_NOTE =
  "Money buyers already paid into this issuer's sales stays in the sale escrow until the Super Admin lifts the freeze: it is neither paid to the issuer nor refunded to the buyers (they keep their units).";

async function platformAdmin(rpc: Rpc): Promise<Address> {
  const [platform] = await findPlatformPda();
  const account = await fetchMaybePlatform(rpc, platform, finalized());
  if (!account.exists || account.programAddress !== ASSET_REGISTRY_PROGRAM_ADDRESS)
    throw new Error("The platform is not initialized on this network");
  return account.data.admin;
}

/**
 * `freeze_issuer_proceeds`, signed by the Super Admin or a live Admin (read
 * at finalized; the program checks the same). Refuses an issuer that is
 * already frozen. Returns the instruction and the reason hash it carries.
 */
export async function buildFreezeIssuerProceeds(
  rpc: Rpc,
  signer: TransactionSigner,
  issuer: Address,
  reason: string,
) {
  if (!reason.trim()) throw new Error("Give the reason for the freeze (its hash is recorded on chain)");
  const superAdmin = await platformAdmin(rpc);
  if (signer.address !== superAdmin) {
    const [record] = await findAdminRecordPda({ authority: signer.address });
    const admin = await fetchMaybeAdmin(rpc, record, finalized());
    if (!admin.exists || admin.programAddress !== ASSET_REGISTRY_PROGRAM_ADDRESS || admin.data.admin !== signer.address)
      throw new Error("Only a Manci Admin or the Super Admin can freeze an issuer's proceeds");
  }
  if (await loadIssuerFreeze(rpc, issuer)) throw new Error("This issuer's proceeds are already frozen");
  const reasonHash = await freezeReasonHash(reason);
  const instruction = await getFreezeIssuerProceedsInstructionAsync({ authority: signer, issuer, reasonHash });
  return { instruction, reasonHash };
}

/** `unfreeze_issuer_proceeds`, signed by the Super Admin; the rent returns to the freezer. */
export async function buildUnfreezeIssuerProceeds(rpc: Rpc, signer: TransactionSigner, issuer: Address) {
  const superAdmin = await platformAdmin(rpc);
  if (signer.address !== superAdmin) throw new Error(`Only the Super Admin (${superAdmin}) can lift a freeze`);
  const freeze = await loadIssuerFreeze(rpc, issuer);
  if (!freeze) throw new Error("This issuer's proceeds are not frozen");
  return getUnfreezeIssuerProceedsInstructionAsync({
    superAdmin: signer,
    issuerFreeze: freeze.address,
    frozenBy: freeze.frozenBy,
  });
}
