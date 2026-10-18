// "Send to holder" (components/share-transfer-panel.tsx), the path mainnet
// issuance took:
//   F004 the recipient is screened against the sanctions lists (the screen
//        Send to wallets runs) and the screening evidence is taken before the
//        wallet opens and cited in every audit row of the send;
//   F050 a "pending" audit row as soon as the network took the transaction
//        (keepalive), before the confirmation wait;
//   F046 a refused status read is retried, and a send not confirmed in time
//        clears the form and keeps it disabled until the operator checked
//        the explorer;
//   F047 one send at a time from the click (a ref, never a state alone);
//   F051 every chain read is retried (lib/rpc-retry) and can be tried again
//        by hand, and the page can ask for a re-read (`reloadKey`).
// Source-order checks on the client component (vitest runs in Node), plus
// the node-safe readers in lib/share-transfer (loadSenderHolding,
// readSignatureOutcome) against RPC stubs.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR, SolanaError, type Address } from "@solana/kit";
import { AccountState, getTokenEncoder } from "@solana-program/token-2022";
import { ASSET_REGISTRY_PROGRAM_ADDRESS, getIssuerEncoder, KybStatus } from "@/lib/generated/asset_registry";
import { findConfigPda, getTransferHookConfigEncoder, RestrictionMode, TRANSFER_HOOK_PROGRAM_ADDRESS } from "@/lib/generated/transfer_hook";
import { withRpcReadRetry } from "@/lib/rpc-retry";
import { loadSenderHolding, readSignatureOutcome, tokenAccountOf, TOKEN_2022 } from "@/lib/share-transfer";

const src = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");
const panel = src("components/share-transfer-panel.tsx");

/** `text` from `start` to the next `end` (both must exist, in that order). */
function between(text: string, start: string, end: string): string {
  const a = text.indexOf(start);
  expect(a, start).toBeGreaterThan(-1);
  const b = text.indexOf(end, a + start.length);
  expect(b, end).toBeGreaterThan(a);
  return text.slice(a, b);
}
const at = (text: string, needle: string) => {
  const i = text.indexOf(needle);
  expect(i, needle).toBeGreaterThan(-1);
  return i;
};

/** send(reason), the click handler, up to the next function. */
const send = between(panel, "async function send(reason: string) {", "async function checkAgain()");

describe("the sanctions screen of the recipient (F004)", () => {
  it("screens in the background within the session, shows the row, and never offers the send on a hit", () => {
    expect(panel).toContain('screenRecipients(session, { shareClass: scPda, wallets: [validRecipient] }, { interactive: false })');
    expect(panel).toContain("screening === \"hit\" ? (");
    expect(panel).toContain("<CheckRow ok={false} text={SCREENING_HIT_TEXT} />");
    expect(panel).toContain('<CheckRow ok text="Sanctions screening: clear." />');
    expect(panel).toContain("<span>{SCREENING_PENDING_TEXT}</span>");
    expect(panel).toContain('current.testRun.state === "passed" && scPda !== null && screening !== "hit"');
  });

  it("screens again under the send's run id, takes the server's evidence, then opens the wallet; a hit stops before the evidence", () => {
    const runId = at(send, "runId = await distributionRunId({");
    const screen = at(send, "const hits = await screenRecipients(session, { shareClass, wallets: [facts.recipient], runId });");
    const evidence = at(send, "evidence = await distributionEvidence(session, { shareClass, runId, wallets: [facts.recipient] });");
    const wallet = at(send, "sig = await tx.send(");
    expect(runId).toBeLessThan(screen);
    expect(screen).toBeLessThan(evidence);
    expect(evidence).toBeLessThan(wallet);
    expect(send.slice(screen, evidence)).toContain("return;");
    expect(send.slice(screen, evidence)).toContain('toast.showError("Tokens not sent", SCREENING_HIT_TEXT);');
  });

  it("every audit row of the send cites the screening, in the per-recipient shape of a distribution row", () => {
    expect(send).toContain("screening: screeningAuditEntry(evidence, facts.recipient),");
    expect(send).toContain("screening_run: runId,");
    expect(panel).toContain("The recipient is screened against the sanctions lists again right before your wallet opens; the");
    expect(panel).toContain("busy={tx.isSending || working !== null}");
    // The network calls stay in the component: lib/share-transfer stays node-safe (tests/share-transfer-node.test.ts).
    expect(src("lib/share-transfer.ts")).not.toContain('from "@/lib/compliance"');
  });
});

describe("the audit trail of a send (F050)", () => {
  it("writes the pending row right after the network took the transaction, with keepalive, and no second one when unconfirmed", () => {
    const taken = at(send, "sig = await tx.send(");
    const pending = at(send, 'audit("pending", sig, { phase: "submitted" });');
    const wait = at(send, "await confirmThenReport(");
    expect(pending).toBeGreaterThan(taken);
    expect(pending).toBeLessThan(wait);
    expect(send).toContain("AUDIT_RETRY_DELAYS_MS,\n          { keepalive: true, timeoutMs: PENDING_AUDIT_ATTEMPT_TIMEOUT_MS },");
    expect(between(send, "unconfirmed: () => {", "settled: async () => {")).not.toContain('audit("pending"');
    // The final rows stay where tests/send-outcome.test.ts pins them.
    expect(between(send, "confirmed: () => {", "failed: () => {")).toContain('audit("success", sig);');
  });
});

describe("a send the network has not confirmed (F046)", () => {
  it("retries a refused status read within the wait", () => {
    expect(send).toContain("waitForSignature(rpc, sig, { timeoutMs: 45_000, retryReads: true })");
  });

  it("clears the form and keeps it disabled until the operator checked the explorer", () => {
    const unconfirmed = between(send, "unconfirmed: () => {", "settled: async () => {");
    expect(unconfirmed).toContain('setRecipientInput("");');
    expect(unconfirmed).toContain("setAmountTouched(false);");
    expect(unconfirmed).toContain("setUnsettled({");
    expect(unconfirmed).toContain("Outcome unknown — check the explorer before sending again.");
    expect(between(send, "confirmed: () => {", "failed: () => {")).toContain("setUnsettled(null);");
    expect(send).toMatch(/if \([^)]*\bpendingSend\b[^)]*\) return;/);
    expect(panel.match(/disabled=\{!!pendingSend\}/g)?.length).toBeGreaterThanOrEqual(3);
    expect(panel).toContain("disabled={!ready || busy || !!pendingSend}");
    expect(panel).toContain("sending again may pay this wallet twice");
    expect(panel).toContain("I checked the explorer — allow sending again");
    expect(panel).toContain('{checking ? "Checking…" : "Check again"}');
    expect(panel).toContain("const outcome = await readSignatureOutcome(rpc, signature);");
    // The box outlives the panel's own visibility (a send of every token leaves no balance to show).
    expect(panel).toContain("if (!visible && !balanceUnread && !pendingSend) return null;");
  });
});

describe("one send at a time, from the click (F047)", () => {
  it("locks with a ref before the screening and the wallet prompt, and unlocks when the send settled or failed", () => {
    expect(panel).toContain("const sendLock = useRef(false);");
    expect(send).toMatch(/^[^\n]*\n\s*if \(sendLock\.current \|\| working !== null \|\| confirming \|\| tx\.isSending \|\| pendingSend\) return;/);
    const lock = at(send, "sendLock.current = true;");
    expect(lock).toBeLessThan(at(send, 'setWorking("Screening the recipient…");'));
    expect(lock).toBeLessThan(at(send, "runId = await distributionRunId({"));
    const finallyBlock = send.slice(send.lastIndexOf("} finally {"));
    expect(finallyBlock).toContain("sendLock.current = false;");
    expect(finallyBlock).toContain("setWorking(null);");
    expect(panel).toContain("const busy = tx.isSending || confirming || working !== null;");
  });
});

describe("chain reads that can be tried again (F051)", () => {
  it("retries the balance, the facts and the test run with the effect's signal, and aborts a superseded load", () => {
    expect(panel).toMatch(/withRpcReadRetry\(\s*\(abortSignal\) => loadSenderHolding\(rpc, \{ wallet, mint: sc\.mint, issuer \}, \{ abortSignal \}\),\s*\{ signal \},?\s*\)/);
    expect(panel).toMatch(/withRpcReadRetry\(\s*\(\) => loadShareTransferFacts\(rpc, \{ mint: sc\.mint, sender: wallet, recipient: validRecipient \}\),\s*\{ signal \},?\s*\)/);
    expect(panel).toMatch(/withRpcReadRetry\(\s*\(\) => simulateInstructions\(rpc, \{ feePayer: wallet, instructions: built\.instructions, network \}\),\s*\{ signal \},?\s*\)/);
    expect(panel.match(/withRpcReadRetry\(/g)).toHaveLength(3);
    expect(panel).toContain("return () => controller.abort();");
    expect(panel).not.toContain("fetchMaybeIssuer(");
  });

  it("shows the failure with Try again instead of hiding, and the page can ask for a re-read", () => {
    expect(panel).toContain("Could not read your balance of this class from the network, so nothing can be sent yet.");
    expect(panel.match(/onClick=\{\(\) => setRefreshKey\(\(k\) => k \+ 1\)\}[^>]*>\s*Try again/g)).toHaveLength(2);
    expect(panel).toContain("reloadKey?: number;");
    expect(panel).toMatch(/\}, \[wallet, issuer, sc\.mint, sc\.mintInitialized, sc\.circulatingSupply, rpc, refreshKey, reloadKey\]\);/);
    expect(panel).toContain("setTreasuryError(key);");
  });
});

// ── The node-safe readers, against RPC stubs ─────────────────────────────────

const MINT = "HRcahPjAhX9ssiY5WvNJxHmy5vuDL7Q6GF6J5gNGjgwC" as Address;
const REGISTRY = "5MofiJNCoCRkNg1f2Yd7368WkjiNxkZZmUTaQo7xLhku" as Address;
const WALLET = "6AnFbinF7X12mACTVEGfjWZyzYGAShEscAB5UgV3vHsP" as Address;
const ISSUER = "7Np41oeYqPefeNQEHSv1UDhYrehxin3NStELsSKCT4K2" as Address;
const SIG = "5".repeat(88);

type Stored = { owner: Address; data: Uint8Array };
const bytes = (encoded: ArrayLike<number>) => Uint8Array.from(Array.from({ length: encoded.length }, (_, i) => encoded[i]));

const httpError = (statusCode: number) =>
  new SolanaError(SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR, { headers: new Headers(), message: "HTTP", statusCode });

/** A getMultipleAccounts stub: `failures` are thrown first, one per call; every call and its send config are recorded. */
function accountsRpc(accounts: Map<string, Stored>, log: { calls: Address[][]; configs: unknown[] }, failures: unknown[] = []) {
  return {
    getMultipleAccounts: (addresses: Address[]) => ({
      send: async (config?: unknown) => {
        log.calls.push(addresses);
        log.configs.push(config);
        if (failures.length > 0) throw failures.shift();
        return {
          context: { slot: BigInt(1) },
          value: addresses.map((a) => {
            const stored = accounts.get(a);
            return stored
              ? {
                  data: [Buffer.from(stored.data).toString("base64"), "base64"],
                  owner: stored.owner,
                  executable: false,
                  lamports: BigInt(1),
                  space: BigInt(stored.data.length),
                  rentEpoch: BigInt(0),
                }
              : null;
          }),
        };
      },
    }),
  } as unknown as Parameters<typeof loadSenderHolding>[0];
}

async function holdingWorld(balance: bigint | null) {
  const accounts = new Map<string, Stored>();
  accounts.set(ISSUER, {
    owner: ASSET_REGISTRY_PROGRAM_ADDRESS,
    data: bytes(getIssuerEncoder().encode({
      authority: WALLET, legalEntityId: new Uint8Array(32), jurisdiction: 688, kybStatus: KybStatus.Verified,
      kybDocHash: new Uint8Array(32), assetsCount: BigInt(1), version: 1, bump: 255,
    })),
  });
  const [config] = await findConfigPda({ mint: MINT });
  accounts.set(config, {
    owner: TRANSFER_HOOK_PROGRAM_ADDRESS,
    data: bytes(getTransferHookConfigEncoder().encode({
      mint: MINT, shareClass: MINT, blocklist: MINT, restrictionMode: RestrictionMode.KycGated, kycRegistry: REGISTRY, version: 1, bump: 255,
    })),
  });
  if (balance !== null) {
    accounts.set(await tokenAccountOf(WALLET, MINT), {
      owner: TOKEN_2022,
      data: bytes(getTokenEncoder().encode({
        mint: MINT, owner: WALLET, amount: balance, delegate: { __option: "None" }, state: AccountState.Initialized,
        isNative: { __option: "None" }, delegatedAmount: BigInt(0), closeAuthority: { __option: "None" }, extensions: { __option: "None" },
      })),
    });
  }
  return { accounts, config };
}

describe("loadSenderHolding", () => {
  it("reads the issuer authority, the hook config and the balance in ONE round trip, with the caller's signal", async () => {
    const { accounts, config } = await holdingWorld(BigInt(250));
    const log = { calls: [] as Address[][], configs: [] as unknown[] };
    const controller = new AbortController();
    const holding = await loadSenderHolding(accountsRpc(accounts, log), { wallet: WALLET, mint: MINT, issuer: ISSUER }, { abortSignal: controller.signal });
    expect(holding).toEqual({ issuerAuthority: WALLET, hookConfigured: true, balance: BigInt(250) });
    expect(log.calls).toEqual([[ISSUER, config, await tokenAccountOf(WALLET, MINT)]]);
    expect(log.configs[0]).toMatchObject({ abortSignal: controller.signal });
  });

  it("no token account reads as a balance of 0; a missing issuer or config reads as unknown and unconfigured", async () => {
    const { accounts } = await holdingWorld(null);
    const log = { calls: [] as Address[][], configs: [] as unknown[] };
    expect((await loadSenderHolding(accountsRpc(accounts, log), { wallet: WALLET, mint: MINT, issuer: ISSUER })).balance).toBe(BigInt(0));
    const empty = await loadSenderHolding(accountsRpc(new Map(), log), { wallet: WALLET, mint: MINT, issuer: ISSUER });
    expect(empty).toEqual({ issuerAuthority: null, hookConfigured: false, balance: BigInt(0) });
  });

  it("an issuer account of another program, or one that does not decode, reads as no authority", async () => {
    const { accounts } = await holdingWorld(BigInt(1));
    const log = { calls: [] as Address[][], configs: [] as unknown[] };
    accounts.set(ISSUER, { owner: TOKEN_2022, data: accounts.get(ISSUER)!.data });
    expect((await loadSenderHolding(accountsRpc(accounts, log), { wallet: WALLET, mint: MINT, issuer: ISSUER })).issuerAuthority).toBeNull();
    accounts.set(ISSUER, { owner: ASSET_REGISTRY_PROGRAM_ADDRESS, data: new Uint8Array(3) });
    expect((await loadSenderHolding(accountsRpc(accounts, log), { wallet: WALLET, mint: MINT, issuer: ISSUER })).issuerAuthority).toBeNull();
  });

  it("a 429 throws (the panel then shows the failure), and succeeds on the retry through withRpcReadRetry", async () => {
    const { accounts } = await holdingWorld(BigInt(7));
    const log = { calls: [] as Address[][], configs: [] as unknown[] };
    const rpc = accountsRpc(accounts, log, [httpError(429)]);
    await expect(loadSenderHolding(rpc, { wallet: WALLET, mint: MINT, issuer: ISSUER })).rejects.toBeInstanceOf(SolanaError);
    const retried = await withRpcReadRetry(() => loadSenderHolding(rpc, { wallet: WALLET, mint: MINT, issuer: ISSUER }), {
      delaysMs: [0],
      sleep: async () => undefined,
    });
    expect(retried.balance).toBe(BigInt(7));
    expect(log.calls).toHaveLength(2);
  });
});

type Status = { err: unknown; confirmationStatus?: string | null } | null;

/** A getSignatureStatuses stub: `failures` are thrown first, one per call; the request is recorded. */
function statusRpc(status: Status, log: { requests: Array<{ signatures: string[]; options: unknown }> }, failures: unknown[] = []) {
  return {
    getSignatureStatuses: (signatures: string[], options: unknown) => ({
      send: async () => {
        log.requests.push({ signatures, options });
        if (failures.length > 0) throw failures.shift();
        return { context: { slot: BigInt(1) }, value: [status] };
      },
    }),
  } as unknown as Parameters<typeof readSignatureOutcome>[0];
}

describe("readSignatureOutcome", () => {
  const quick = { delaysMs: [0], sleep: async () => undefined };

  it("asks once with the history searched, and reads confirmed, finalized, failed and unknown", async () => {
    const log = { requests: [] as Array<{ signatures: string[]; options: unknown }> };
    expect(await readSignatureOutcome(statusRpc({ err: null, confirmationStatus: "confirmed" }, log), SIG)).toBe("confirmed");
    expect(log.requests).toEqual([{ signatures: [SIG], options: { searchTransactionHistory: true } }]);
    expect(await readSignatureOutcome(statusRpc({ err: null, confirmationStatus: "finalized" }, log), SIG)).toBe("confirmed");
    expect(await readSignatureOutcome(statusRpc({ err: { InstructionError: [1, "Custom"] }, confirmationStatus: "confirmed" }, log), SIG)).toBe("failed");
    expect(await readSignatureOutcome(statusRpc({ err: null, confirmationStatus: "processed" }, log), SIG)).toBe("unknown");
    expect(await readSignatureOutcome(statusRpc(null, log), SIG)).toBe("unknown");
  });

  it("retries a refused read; any other failure throws", async () => {
    const log = { requests: [] as Array<{ signatures: string[]; options: unknown }> };
    expect(await readSignatureOutcome(statusRpc({ err: null, confirmationStatus: "confirmed" }, log, [httpError(429)]), SIG, quick)).toBe("confirmed");
    expect(log.requests).toHaveLength(2);
    await expect(readSignatureOutcome(statusRpc(null, log, [new Error("bad request")]), SIG, quick)).rejects.toThrow("bad request");
  });
});
