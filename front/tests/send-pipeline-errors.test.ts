// r2g4-03 / r2g4-06 / r2g4-08: what a refused, silent or late RPC reads as
// (never kit's production text "Solana error #8100002; Decode this error by
// running npx …"), with the status named and the wallet's signing taken into
// account; the genesis read retried; and the custody-state refusals worded.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  address,
  SOLANA_ERROR__INSTRUCTION_PLANS__FAILED_TO_EXECUTE_TRANSACTION_PLAN,
  SOLANA_ERROR__JSON_RPC__INTERNAL_ERROR,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_NODE_UNHEALTHY,
  SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR,
  SolanaError,
  type GetGenesisHashApi,
  type Rpc,
} from "@solana/kit";
import { REALIZE_CUSTODY_VAULT_DISCRIMINATOR, RETURN_CUSTODY_VAULT_DISCRIMINATOR, TRIGGER_CUSTODY_VAULT_DISCRIMINATOR } from "@/lib/generated/asset_registry";
import { CLUSTER_GENESIS_HASHES, createNetworkVerifier, NetworkIdentityError } from "@/lib/network-identity";
import {
  contextualErrorHint,
  CUSTODY_VAULT_AUTHORITY_HINT,
  INVALID_VAULT_STATE_HINT,
  KYC_REGISTRY_NOT_AUTHORITY_HINT,
  programErrorHint,
  REGISTRY_ERROR_HINTS,
  RETURN_NOT_ALLOWED_HINT,
} from "@/lib/program-errors";
import { refusalFromSimulation, rpcFailureAt, SIMULATION_TIMEOUT_MS, SimulationUnavailableError, type SimulationVerdict } from "@/lib/simulation-gate";
import { explainRpcFailure, explainSendError, markSentAfterSigning, sendRpcFailure } from "@/lib/tx-error";

const REGISTRY_PROGRAM = "FJs1EM1ND89L9sUXaS8VBKYXjmoXCkkVSJKRE19hmYxS";

const http = (statusCode: number) => new SolanaError(SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR, { headers: new Headers(), message: "HTTP", statusCode });
const timeout = () => new DOMException("The operation timed out.", "TimeoutError");
const unhealthy = () => new SolanaError(SOLANA_ERROR__JSON_RPC__SERVER_ERROR_NODE_UNHEALTHY, { numSlotsBehind: 12 });
/** What the SDK's executor throws when sendTransaction failed after signing: the failure sits under the plan result's status. */
const underExecutor = (error: unknown) =>
  new SolanaError(SOLANA_ERROR__INSTRUCTION_PLANS__FAILED_TO_EXECUTE_TRANSACTION_PLAN, {
    transactionPlanResult: { kind: "single", message: {}, status: { kind: "failed", error } },
  });

// As a production build words every kit error (process.env.NODE_ENV is read when the error is made).
beforeEach(() => vi.stubEnv("NODE_ENV", "production"));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("what kind of RPC failure an error is (rpcFailureAt)", () => {
  it("reads the kind from codes and names, never from the message", () => {
    expect(http(429).message).toMatch(/^Solana error #8100002; Decode this error by running/);
    expect(rpcFailureAt(http(429))).toEqual({ kind: "http", status: 429 });
    expect(rpcFailureAt(new TypeError("Failed to fetch"))).toEqual({ kind: "no-answer" });
    expect(rpcFailureAt(new TypeError("Load failed"))).toEqual({ kind: "no-answer" });
    expect(rpcFailureAt(timeout())).toEqual({ kind: "timeout" });
    expect(rpcFailureAt(new DOMException("aborted", "AbortError"))).toEqual({ kind: "timeout" });
    expect(rpcFailureAt(unhealthy())).toEqual({ kind: "unhealthy" });
    expect(rpcFailureAt(new TypeError("x is not a function"))).toBeNull();
    expect(rpcFailureAt(new Error("fetch failed"))).toBeNull();
    expect(rpcFailureAt(new SolanaError(SOLANA_ERROR__JSON_RPC__INTERNAL_ERROR, { __serverMessage: "boom" }))).toBeNull();
    expect(rpcFailureAt(null)).toBeNull();
  });
});

describe("the gate could not run (SimulationUnavailableError)", () => {
  const unavailable = (cause: unknown) => new SimulationUnavailableError("devnet", cause).message;
  const opening = "Could not test this transaction on devnet before opening your wallet, so nothing was sent";

  it("names the HTTP status, not the decode text", () => {
    expect(unavailable(http(429))).toBe(`${opening} (the RPC answered HTTP 429). Try again in a moment.`);
    expect(unavailable(http(503))).toBe(`${opening} (the RPC answered HTTP 503). Try again in a moment.`);
    expect(unavailable(http(429))).not.toMatch(/npx|Solana error #/);
    // Wrapped a few levels down as well.
    expect(unavailable(new Error("read failed", { cause: new Error("transport", { cause: http(429) }) }))).toContain("HTTP 429");
  });

  it("a 401 / 403 is not a passing moment: the RPC refuses this site", () => {
    expect(unavailable(http(403))).toBe(`${opening} (the RPC refused access, HTTP 403). If it happens again, tell Manci.`);
    expect(unavailable(http(401))).toContain("HTTP 401");
  });

  it("no answer, a cut-off, an unhealthy node, another kit error by its code only, a plain error by its message", () => {
    expect(unavailable(new TypeError("Failed to fetch"))).toBe(`${opening} (no answer from the RPC). Try again in a moment.`);
    expect(unavailable(timeout())).toBe(`${opening} (the RPC did not answer within ${SIMULATION_TIMEOUT_MS / 1000} s). Try again in a moment.`);
    expect(unavailable(unhealthy())).toBe(`${opening} (the RPC node says it is unhealthy). Try again in a moment.`);
    const other = unavailable(new SolanaError(SOLANA_ERROR__JSON_RPC__INTERNAL_ERROR, { __serverMessage: "boom" }));
    expect(other).toBe(`${opening} (Solana error #${SOLANA_ERROR__JSON_RPC__INTERNAL_ERROR}). Try again in a moment.`);
    expect(other).not.toMatch(/npx|boom/);
    expect(unavailable(new Error("fetch failed"))).toBe(`${opening} (fetch failed). Try again in a moment.`);
    expect(unavailable("x")).toBe(`${opening}. Try again in a moment.`);
    expect(explainSendError(new SimulationUnavailableError("devnet", http(429)))).toBe(unavailable(http(429)));
  });
});

describe("explainSendError on an RPC that refused, did not answer or answered too late", () => {
  it("before the wallet: nothing was sent, the status named", () => {
    expect(explainSendError(http(429))).toBe("The Solana RPC refused the request (HTTP 429). Nothing was sent — try again in a moment.");
    expect(explainSendError(new Error("wrapped", { cause: http(502) }))).toBe("The Solana RPC refused the request (HTTP 502). Nothing was sent — try again in a moment.");
    expect(explainSendError(http(403))).toBe("The Solana RPC refused access (HTTP 403). Nothing was sent — if it happens again, tell Manci.");
    expect(explainSendError(new TypeError("Failed to fetch"))).toBe("The Solana RPC did not answer. Nothing was sent — check your connection and try again in a moment.");
    expect(explainSendError(timeout())).toBe("The network did not answer in time; nothing was sent. Try again in a moment.");
    expect(explainSendError(unhealthy())).toBe("The Solana RPC node says it is unhealthy (behind the network). Nothing was sent — try again in a moment.");
    for (const err of [http(429), new TypeError("Failed to fetch"), unhealthy()]) expect(explainSendError(err)).not.toMatch(/npx|Solana error #/);
  });

  it("after the wallet signed (the SDK's executor, or the batch path's mark): the outcome is unknown", () => {
    const may = "The transaction may not have been broadcast; check it in the explorer before retrying.";
    expect(explainSendError(underExecutor(http(503)))).toBe(`The Solana RPC refused the request (HTTP 503) after your wallet signed. ${may}`);
    expect(explainSendError(underExecutor(new TypeError("Failed to fetch")))).toBe(`The Solana RPC did not answer after your wallet signed. ${may}`);
    expect(explainSendError(underExecutor(unhealthy()))).toBe(`The Solana RPC node says it is unhealthy (behind the network) after your wallet signed. ${may}`);
    expect(explainSendError(markSentAfterSigning(http(429)))).toBe(`The Solana RPC refused the request (HTTP 429) after your wallet signed. ${may}`);
    expect(explainSendError(markSentAfterSigning(timeout()))).toBe(
      "The network did not answer in time after your wallet signed. The transaction may not have been sent — check the explorer before retrying.",
    );
    // A cut-off under the executor is not placed by nesting alone: only the mark says it came after signing.
    expect(explainSendError(underExecutor(timeout()))).toBe("The network did not answer in time; nothing was sent. Try again in a moment.");
    for (const err of [underExecutor(http(503)), markSentAfterSigning(http(429))]) expect(explainSendError(err)).not.toMatch(/Nothing was sent|npx/);
  });

  it("the mark is on the object, and the chain is read breadth first", () => {
    const marked = markSentAfterSigning(new Error("send", { cause: http(500) }));
    expect(sendRpcFailure(marked)).toEqual({ failure: { kind: "http", status: 500 }, afterSigning: true });
    expect(sendRpcFailure(http(500))).toEqual({ failure: { kind: "http", status: 500 }, afterSigning: false });
    expect(sendRpcFailure(new Error("plain"))).toBeNull();
    expect(explainRpcFailure(new Error("plain"))).toBeNull();
    expect(markSentAfterSigning(null)).toBeNull();
    expect(markSentAfterSigning("text")).toBe("text");
  });

  it("a program refusal with logs, a pause refusal and a wallet rejection keep their own wording", () => {
    const withLogs = Object.assign(new Error("Transaction simulation failed"), {
      context: { logs: [`Program ${REGISTRY_PROGRAM} failed: custom program error: 0x1800`] },
      cause: http(429),
    });
    expect(explainSendError(withLogs)).toMatch(/PartyBlocklisted/);
    expect(explainSendError(Object.assign(new Error("User rejected the request."), { code: 4001, cause: http(429) }))).toBe("Wallet rejected the transaction.");
  });
});

describe("the genesis check is retried on a refusal of the moment (createNetworkVerifier retryReads)", () => {
  function genesisRpc(answers: (() => string | never)[]) {
    const send = vi.fn(async (options?: { abortSignal?: AbortSignal }) => {
      void options;
      const next = answers.shift();
      if (!next) throw new Error("no more answers");
      return next();
    });
    return { rpc: { getGenesisHash: () => ({ send }) } as unknown as Rpc<GetGenesisHashApi>, send };
  }
  const refuse = (status: number) => () => {
    throw http(status);
  };
  const devnet = () => CLUSTER_GENESIS_HASHES.devnet;

  it("with retryReads: a 429 once, then the hash: the check passes, each attempt with its own cut-off", async () => {
    const { rpc, send } = genesisRpc([refuse(429), devnet]);
    await expect(createNetworkVerifier(rpc, "devnet", { retryReads: { delaysMs: [1, 1, 1], sleep: async () => {} } })()).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledTimes(2);
    const signals = send.mock.calls.map((call) => call[0]?.abortSignal);
    expect(signals.every((s) => s instanceof AbortSignal)).toBe(true);
    expect(signals[0]).not.toBe(signals[1]);
  });

  it("without it (the server's verifier): one read, the sanitized message naming the status", async () => {
    const { rpc, send } = genesisRpc([refuse(429), devnet]);
    const failure = await createNetworkVerifier(rpc, "devnet")().catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(NetworkIdentityError);
    expect((failure as Error).message).toBe("Cannot verify the Solana network (the RPC answered HTTP 429). Check the RPC connection and try again.");
    expect((failure as Error).message).not.toMatch(/npx/);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("refused on every attempt, or failed in another way: not retried past the waits, never a URL or key in the message", async () => {
    const limited = genesisRpc([refuse(429), refuse(503), refuse(429), refuse(429), devnet]);
    await expect(createNetworkVerifier(limited.rpc, "devnet", { retryReads: { delaysMs: [1, 1, 1], sleep: async () => {} } })()).rejects.toThrow(
      "Cannot verify the Solana network (the RPC answered HTTP 429)",
    );
    expect(limited.send).toHaveBeenCalledTimes(4);
    const other = genesisRpc([
      () => {
        throw new Error("https://rpc.invalid/?api-key=secret");
      },
      devnet,
    ]);
    const failure = await createNetworkVerifier(other.rpc, "devnet", { retryReads: true })().catch((e: unknown) => e);
    expect((failure as Error).message).toBe("Cannot verify the Solana network. Check the RPC connection and try again.");
    expect(other.send).toHaveBeenCalledTimes(1);
  });
});

describe("custody-state refusals are worded (r2g4-08)", () => {
  /** A registry instruction refused at message index 2 ([limit, price, ix]), Anchor naming the account when it does. */
  function registryRefusal(code: number, name: string, account?: string): SimulationVerdict {
    const where = account ? `caused by account: ${account}.` : "thrown in programs/asset_registry/src/instructions/x.rs:10.";
    return {
      err: { InstructionError: [2, { Custom: code }] },
      logs: [
        `Program ${REGISTRY_PROGRAM} invoke [1]`,
        `Program log: AnchorError ${where} Error Code: ${name}. Error Number: ${code}. Error Message: x.`,
        `Program ${REGISTRY_PROGRAM} failed: custom program error: 0x${code.toString(16)}`,
      ],
      unitsConsumed: 1,
    };
  }
  const app = (discriminator: Uint8Array) => [{ programAddress: address(REGISTRY_PROGRAM), data: discriminator }];
  const refuse = (verdict: SimulationVerdict, instructions: ReturnType<typeof app>) =>
    refusalFromSimulation(verdict, { appInstructions: instructions, messageInstructionCount: 3, network: "devnet" })!;
  const withLogs = (logs: readonly string[]) => Object.assign(new Error("Transaction simulation failed"), { context: { logs } });

  it("the tables: ReturnNotAllowed (6052) in the registry's; InvalidVaultState (6015) by Anchor's name, as its number is a hook code too", () => {
    expect(REGISTRY_ERROR_HINTS.get(6052)).toBe(RETURN_NOT_ALLOWED_HINT);
    expect(programErrorHint({ program: "asset_registry", code: 6052 })).toBe(RETURN_NOT_ALLOWED_HINT);
    expect(REGISTRY_ERROR_HINTS.has(6015)).toBe(false);
    expect(programErrorHint({ program: "transfer_hook", code: 6015 })).toBeNull();
    expect(contextualErrorHint("Program log: AnchorError caused by account: custody_vault. Error Code: InvalidVaultState. Error Number: 6015.")).toBe(INVALID_VAULT_STATE_HINT);
    expect(contextualErrorHint("Program log: AnchorError caused by account: custody_vault. Error Code: Unauthorized. Error Number: 6001.")).toBe(CUSTODY_VAULT_AUTHORITY_HINT);
    expect(contextualErrorHint("Program log: AnchorError caused by account: kyc_registry. Error Code: Unauthorized. Error Number: 6001.")).toBe(KYC_REGISTRY_NOT_AUTHORITY_HINT);
    expect(contextualErrorHint("Program log: AnchorError caused by account: transfer. Error Code: InvalidAuthorityTransfer. Error Number: 6015.")).toBeNull();
  });

  it("Confirm on a vault already triggered or realized (trigger / realize, 6015): a next step, not a bare code", () => {
    const trigger = refuse(registryRefusal(6015, "InvalidVaultState", "custody_vault"), app(TRIGGER_CUSTODY_VAULT_DISCRIMINATOR));
    expect([trigger.program, trigger.code, trigger.errorName, trigger.instructionIndex]).toEqual(["asset_registry", 6015, "InvalidVaultState", 0]);
    expect(trigger.message).toBe(
      "This transaction would fail, so your wallet was not opened. Step 1 of 1 (trigger custody vault) was refused by the Manci registry program: " +
        "This vault is not in the state this step needs: it was already triggered, realized or returned, or not yet triggered. Reload the page; if you already sent the burn or the return, record that transaction instead (InvalidVaultState).",
    );
    expect(explainSendError(trigger)).toBe(trigger.message);
    const realize = refuse(registryRefusal(6015, "InvalidVaultState", "custody_vault"), app(REALIZE_CUSTODY_VAULT_DISCRIMINATOR));
    expect(realize.detail).toMatch(/^Step 1 of 1 \(realize custody vault\) was refused by the Manci registry program: This vault is not in the state this step needs/);
    // After the wallet (a preflight failure with logs) the same words.
    expect(explainSendError(withLogs(registryRefusal(6015, "InvalidVaultState", "custody_vault").logs))).toBe(INVALID_VAULT_STATE_HINT);
  });

  it("Cancel & return by a wallet that is not the vault authority before the deadline (6052)", () => {
    const refusal = refuse(registryRefusal(6052, "ReturnNotAllowed"), app(RETURN_CUSTODY_VAULT_DISCRIMINATOR));
    expect(refusal.detail).toBe(
      "Step 1 of 1 (return custody vault) was refused by the Manci registry program: " +
        "Only the vault authority (the admin wallet that opened this escrow) can return it before its deadline; after the deadline anyone can (ReturnNotAllowed).",
    );
    expect(explainSendError(withLogs(registryRefusal(6052, "ReturnNotAllowed").logs))).toBe(RETURN_NOT_ALLOWED_HINT);
  });

  it("trigger / realize by a wallet that is not the vault authority (Unauthorized on custody_vault, 6001)", () => {
    const refusal = refuse(registryRefusal(6001, "Unauthorized", "custody_vault"), app(TRIGGER_CUSTODY_VAULT_DISCRIMINATOR));
    expect(refusal.detail).toBe(
      "Step 1 of 1 (trigger custody vault) was refused by the Manci registry program: " +
        "This custody vault refused the transaction: this wallet is not the vault authority (the admin wallet that opened it, the only one that can trigger or confirm it), or an account passed does not belong to this vault (Unauthorized).",
    );
    expect(explainSendError(withLogs(registryRefusal(6001, "Unauthorized", "custody_vault").logs))).toBe(CUSTODY_VAULT_AUTHORITY_HINT);
    // The sale's and the KYC registry's Unauthorized keep their own words.
    expect(refuse(registryRefusal(6001, "Unauthorized", "kyc_registry"), app(TRIGGER_CUSTODY_VAULT_DISCRIMINATOR)).detail).toContain(KYC_REGISTRY_NOT_AUTHORITY_HINT.slice(0, -1));
  });
});
