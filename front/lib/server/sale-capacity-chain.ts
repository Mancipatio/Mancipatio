// SERVER-ONLY — chain reads behind the raise-cap ledger (lib/server/sale-capacity.ts).
//
// Every decision that could free capacity reads the approval AND the sale in
// ONE getMultipleAccounts call (one slot): two separate reads through a
// load-balanced RPC can come from nodes at different slots and see the
// approval closed by open_sale before the Sale it created.

import "server-only";
import {
  address,
  fetchEncodedAccounts,
  getBase58Decoder,
  parseBase64RpcAccount,
  signature as toSignature,
  type Address,
  type Base58EncodedBytes,
} from "@solana/kit";
import {
  ASSET_REGISTRY_PROGRAM_ADDRESS,
  decodeSale,
  decodeSaleApproval,
  getSaleApprovalDiscriminatorBytes,
  type Sale,
  type SaleApproval,
} from "@/lib/generated/asset_registry";
import { getServerRpc } from "@/lib/server/rpc";

/** `8 + SaleApproval::INIT_SPACE` (pinned by the program's layout test). */
export const SALE_APPROVAL_SIZE = 213;

function chainSignal(signal?: AbortSignal) {
  const timeout = AbortSignal.timeout(12_000);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export type SaleState = { approval: SaleApproval | null; sale: Sale | null };

/** The approval and the sale of one id, read at a single slot. */
export async function readApprovalAndSale(
  approvalPda: string, salePda: string, commitment: "confirmed" | "finalized", signal?: AbortSignal,
): Promise<SaleState> {
  const [approval, sale] = await fetchEncodedAccounts(getServerRpc(), [address(approvalPda), address(salePda)], {
    commitment, abortSignal: chainSignal(signal),
  });
  for (const account of [approval, sale]) {
    if (account.exists && account.programAddress !== ASSET_REGISTRY_PROGRAM_ADDRESS) throw new Error("Unexpected account owner");
  }
  return {
    approval: approval.exists ? decodeSaleApproval(approval).data : null,
    sale: sale.exists ? decodeSale(sale).data : null,
  };
}

/**
 * Proves a transaction whose blockhash expires at `lastValidBlockHeight` can
 * no longer land: the finalized chain is past that height. Every block it
 * could have landed in is then finalized, so an account it would have created
 * and that is absent at `finalized` (read AFTER this check) was never created.
 */
export async function blockhashExpired(lastValidBlockHeight: bigint, signal?: AbortSignal): Promise<boolean> {
  const height = await getServerRpc().getBlockHeight({ commitment: "finalized" }).send({ abortSignal: chainSignal(signal) });
  return height > lastValidBlockHeight;
}

/** "failed" when the transaction landed with an error, "unknown" when it is not (yet) visible. */
export async function signatureOutcome(sig: string, signal?: AbortSignal): Promise<"failed" | "succeeded" | "unknown"> {
  const { value } = await getServerRpc()
    .getSignatureStatuses([toSignature(sig)], { searchTransactionHistory: true })
    .send({ abortSignal: chainSignal(signal) });
  const status = value[0];
  if (!status) return "unknown";
  return status.err ? "failed" : "succeeded";
}

export type LiveApproval = SaleApproval & { address: Address };

/** Every SaleApproval account (unused approvals; consumed / revoked ones are closed). */
export async function listLiveApprovals(signal?: AbortSignal): Promise<LiveApproval[]> {
  const discriminator = getBase58Decoder().decode(getSaleApprovalDiscriminatorBytes()) as Base58EncodedBytes;
  const rows = await getServerRpc().getProgramAccounts(ASSET_REGISTRY_PROGRAM_ADDRESS, {
    encoding: "base64",
    commitment: "confirmed",
    filters: [
      { dataSize: BigInt(SALE_APPROVAL_SIZE) },
      { memcmp: { offset: BigInt(0), bytes: discriminator, encoding: "base58" } },
    ],
  }).send({ abortSignal: chainSignal(signal) });
  return rows.map((row) => ({
    ...decodeSaleApproval(parseBase64RpcAccount(row.pubkey, row.account as never)).data,
    address: row.pubkey,
  }));
}

export type FinalizedSignature = { signature: string; blockTime: number };

/**
 * Successful FINALIZED transactions that touched `account` with a block time
 * in [fromSecs, toSecs], oldest first. Pages back (newest first, 100 per
 * page, at most `maxPages`) until it passes `fromSecs`; `complete` is false
 * when the pages ran out first, so a caller can tell "none" from "not all seen".
 */
export async function listFinalizedSignatures(
  account: string, fromSecs: number, toSecs: number, signal?: AbortSignal, maxPages = 3,
): Promise<{ signatures: FinalizedSignature[]; complete: boolean }> {
  const out: FinalizedSignature[] = [];
  let before: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const rows = await getServerRpc().getSignaturesForAddress(address(account), {
      commitment: "finalized", limit: 100, ...(before ? { before: toSignature(before) } : {}),
    }).send({ abortSignal: chainSignal(signal) });
    for (const row of rows) {
      const time = row.blockTime === null ? null : Number(row.blockTime);
      if (row.err === null && time !== null && time >= fromSecs && time <= toSecs) out.push({ signature: row.signature, blockTime: time });
    }
    const last = rows[rows.length - 1];
    if (rows.length < 100 || !last || (last.blockTime !== null && Number(last.blockTime) < fromSecs)) {
      return { signatures: out.reverse(), complete: true };
    }
    before = last.signature;
  }
  return { signatures: out.reverse(), complete: false };
}

/** A finalized transaction (json encoding), or null when it is not finalized (yet). */
export async function finalizedTransaction(sig: string, signal?: AbortSignal): Promise<unknown | null> {
  return getServerRpc().getTransaction(toSignature(sig), {
    commitment: "finalized", encoding: "json", maxSupportedTransactionVersion: 0,
  }).send({ abortSignal: chainSignal(signal) });
}
