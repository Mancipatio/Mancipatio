// The "Anchor a document" panel on /admin/platform, rendered to static markup
// (no jsdom here): nothing for a wallet that is not the on-chain Super Admin
// (or no wallet), the panel for the Super Admin; the page mounts it with
// Platform.admin; a pending anchor kept in this browser is restored (for its
// network and signer only) and blocks a new send. The panel's send → confirm
// → record flow and its result card (lib/document-anchor-client.ts) are
// driven directly: what is saved, cleared, recorded and offered after each
// outcome, what "Forget it" warns about, and where a failed send got (the
// wallet's signer, tracked: before the wallet, in it, after it handed the
// signed transaction back, after the send resolved; the real send path is in
// tests/document-anchor-send.test.ts), and the warning kept for a send that
// may have been sent: per network and wallet, restored on mount, blocking a
// new send until dismissed or recorded. The page's recording retry: only
// "not yet" is retried. And the browser hash of a file against known SHA-256
// values.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const SA = "8TEmJBkcoBsUjRPftZ3kdWb9NmZDy7Zy3a7GqFCK5Nx9";
const ADMIN = "6AnFbinF7X12mACTVEGfjWZyzYGAShEscAB5UgV3vHsP";

const hooks = vi.hoisted(() => ({ wallet: null as string | null }));
vi.mock("@solana/react-hooks", () => ({
  useWalletConnection: () => ({
    isReady: true,
    connected: hooks.wallet !== null,
    wallet: hooks.wallet === null ? undefined : { account: { address: hooks.wallet } },
  }),
  useSolanaClient: () => ({ runtime: { rpc: {} } }),
  useSendTransaction: () => ({ send: vi.fn(), isSending: false, signature: null, error: null }),
}));
vi.mock("@/lib/toast", () => ({
  useToast: () => ({ show: vi.fn(), showTx: vi.fn(), showError: vi.fn(), showPending: vi.fn(), dismiss: vi.fn(), toasts: [] }),
}));
const fetches = vi.hoisted(() => ({ results: [] as (unknown | Error)[], calls: 0 }));
vi.mock("@/lib/siws-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/siws-client")>()),
  signedFetch: vi.fn(async () => {
    const next = fetches.results[fetches.calls++];
    if (next instanceof Error) throw next;
    return next;
  }),
}));

import { DocumentAnchorPanel } from "@/app/admin/platform/document-anchor-panel";
import {
  FORGET_CONFIRMED_WARNING,
  FORGET_UNCONFIRMED_WARNING,
  RECORD_RETRY_DELAYS_MS,
  adoptUncertainSend,
  anchorBlocksNewSend,
  anchorResultView,
  anchorSendMayHaveLanded,
  clearUncertainSend,
  createAnchorSendTracker,
  dismissAnchorResult,
  readPendingAnchor,
  readUncertainSend,
  recordDocumentAnchorWithRetry,
  restoredAnchorResult,
  runDocumentAnchorFlow,
  savePendingAnchor,
  saveUncertainSend,
  withRecordedAnchor,
  type AnchorFlowHooks,
  type AnchorResult,
  type PendingAnchor,
  type RecordedAnchor,
  type UncertainAnchorSend,
} from "@/lib/document-anchor-client";
import { DOCUMENT_ANCHOR_NOT_YET } from "@/lib/document-anchor";
import {
  address,
  getBase58Encoder,
  type SignatureBytes,
  type TransactionModifyingSigner,
  type TransactionPartialSigner,
  type TransactionSendingSigner,
  type TransactionSigner,
} from "@solana/kit";
import { detectNetwork, explorerAddressUrl, explorerTxUrl, type Network } from "@/lib/network";
import type { SignatureOutcome } from "@/lib/simulation-gate";
import { sha256HexOfFile } from "@/lib/storage-client";
import { TransactionWalletChangedError } from "@/lib/transaction-wallet-policy";

const render = (superAdmin: string) => renderToStaticMarkup(createElement(DocumentAnchorPanel, { superAdmin }));

const REFERENCE = "MANCI-2026-0001";
const SHA = "a2546dd318ea95b210a4eb62a45b84341d74fa065c3da1c1279fd62135f22bc7";
const SIG = "5RBDZNDobPiJGpQsfcvPLuSdzyUXRxBnpXNU4sFQg2ud3sTiSPyWnPrfvyN4myMYTvEUWjtYnGijuryNNrXqeDqm";
const PENDING_KEY = "manci:document-anchor:pending:v1";
const UNCERTAIN_KEY = "manci:document-anchor:uncertain:v1";

/** A window with a working localStorage (the node test environment has none). */
function stubStorage(): Map<string, string> {
  const store = new Map<string, string>();
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    },
  });
  return store;
}
afterEach(() => {
  vi.unstubAllGlobals();
});

const pendingOf = (over: Partial<PendingAnchor> = {}): PendingAnchor => ({
  reference: REFERENCE, sha256: SHA, signature: SIG, network: detectNetwork(), signer: SA, ...over,
});
const resultOf = (over: Partial<AnchorResult> = {}): AnchorResult => ({
  anchor: pendingOf(), memo: `${REFERENCE} sha256:${SHA}`, outcome: null, record: null, recordError: null, ...over,
});
const uncertainOf = (over: Partial<UncertainAnchorSend> = {}): UncertainAnchorSend => ({
  reference: REFERENCE, sha256: SHA, network: detectNetwork(), signer: SA, signature: SIG, at: "2026-10-05T10:00:00.000Z", ...over,
});
const recorded: RecordedAnchor = {
  id: "row-1", reference: REFERENCE, sha256: SHA, signature: SIG, signer: SA, slot: 100, blockTime: 1_700_000_000,
  commitment: "finalized", recordedAt: "2026-10-05T10:00:00Z", duplicate: false,
};

describe("DocumentAnchorPanel gating", () => {
  it("renders nothing for a wallet that is not the Super Admin, or no wallet", () => {
    hooks.wallet = ADMIN;
    expect(render(SA)).toBe("");
    hooks.wallet = null;
    expect(render(SA)).toBe("");
  });

  it("renders the panel for the Super Admin: reference, file picker, pasted hash", () => {
    hooks.wallet = SA;
    const markup = render(SA);
    expect(markup).toContain("Anchor a document");
    expect(markup).toContain('type="file"');
    expect(markup).toContain('placeholder="MANCI-2026-0001"');
    expect(markup).toContain("paste its SHA-256");
    expect(markup).toContain("Review and anchor");
    // Nothing to sign before both inputs are valid.
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>Review and anchor<\/button>/);
  });

  it("the platform page mounts it with the on-chain Platform.admin", () => {
    const page = readFileSync(join(process.cwd(), "app/admin/platform/page.tsx"), "utf8");
    expect(page).toContain('import { DocumentAnchorPanel } from "./document-anchor-panel";');
    expect(page).toContain("<DocumentAnchorPanel superAdmin={platform.admin} />");
  });
});

describe("recordDocumentAnchorWithRetry", () => {
  const input = { signature: "sig", reference: "MANCI-2026-0001", sha256: "a".repeat(64) };
  const sleep = vi.fn(async () => {});
  beforeEach(() => {
    fetches.results = [];
    fetches.calls = 0;
    sleep.mockClear();
  });

  it("waits and posts again while the server's node does not show the transaction yet", async () => {
    fetches.results = [new Error(`${DOCUMENT_ANCHOR_NOT_YET} — try again`), new Error(`${DOCUMENT_ANCHOR_NOT_YET} — try again`), { id: "row-1" }];
    await expect(recordDocumentAnchorWithRetry(null, input, [1, 2, 3], sleep)).resolves.toEqual({ id: "row-1" });
    expect(fetches.calls).toBe(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("throws any other refusal at once, and gives up after the last wait", async () => {
    fetches.results = [new Error("Not recorded: The memo text is not the expected anchor text")];
    await expect(recordDocumentAnchorWithRetry(null, input, [1, 2], sleep)).rejects.toThrow(/memo text/);
    expect(fetches.calls).toBe(1);
    fetches.results = [new Error(DOCUMENT_ANCHOR_NOT_YET), new Error(DOCUMENT_ANCHOR_NOT_YET), new Error(DOCUMENT_ANCHOR_NOT_YET)];
    fetches.calls = 0;
    await expect(recordDocumentAnchorWithRetry(null, input, [1, 2], sleep)).rejects.toThrow(DOCUMENT_ANCHOR_NOT_YET);
    expect(fetches.calls).toBe(3);
  });

  it("waits 40 s in all by default: finalization follows the browser's confirmation by about 13 s", () => {
    expect(RECORD_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0)).toBe(40_000);
  });
});

describe("the pending anchor kept in this browser", () => {
  it("is restored on mount for this network and signer only, and blocks a new send until it is recorded", () => {
    const store = stubStorage();
    hooks.wallet = SA;
    savePendingAnchor(pendingOf());
    const markup = render(SA);
    expect(markup).toContain("Sent earlier from this browser, not recorded yet");
    expect(markup).toContain(SIG);
    expect(markup).toContain("Record in the audit log");
    expect(markup).toContain("not recorded in the audit log yet");
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>Review and anchor<\/button>/);
    // Another network or another signer: not this panel's anchor.
    const other: Network = detectNetwork() === "mainnet" ? "devnet" : "mainnet";
    store.set(PENDING_KEY, JSON.stringify(pendingOf({ network: other })));
    expect(restoredAnchorResult(detectNetwork(), SA)).toBeNull();
    expect(render(SA)).not.toContain("Sent earlier from this browser");
    store.set(PENDING_KEY, JSON.stringify(pendingOf({ signer: ADMIN })));
    expect(restoredAnchorResult(detectNetwork(), SA)).toBeNull();
    // A damaged entry is ignored.
    store.set(PENDING_KEY, "{not json");
    expect(readPendingAnchor(detectNetwork(), SA)).toBeNull();
  });

  it("restores nothing when storage is unavailable", () => {
    hooks.wallet = SA;
    expect(restoredAnchorResult(detectNetwork(), SA)).toBeNull();
    expect(render(SA)).not.toContain("Sent earlier from this browser");
  });
});

type Track = (signer: TransactionSigner) => TransactionSigner;

const SIG_BYTES = getBase58Encoder().encode(SIG) as SignatureBytes;
/** What the wallet signers take and give back (a compiled transaction with its lifetime). */
type SignedTx = Awaited<ReturnType<TransactionModifyingSigner["modifyAndSignTransactions"]>>[number];
const UNSIGNED = { messageBytes: new Uint8Array([1, 2, 3]), signatures: { [SA]: null } } as unknown as SignedTx;

/**
 * The wallet's signer as createWalletTransactionSigner makes it: "partial" for a
 * wallet with signTransaction (it only signs), "send" for one with only
 * sendTransaction (it broadcasts itself). `fail`: the wallet call throws.
 */
function walletSignerOf(kind: "partial" | "send", fail: Error | null = null): TransactionSigner {
  const addr = address(SA);
  if (kind === "send") {
    const sending: TransactionSendingSigner = {
      address: addr,
      signAndSendTransactions: async () => {
        if (fail) throw fail;
        return [SIG_BYTES];
      },
    };
    return sending;
  }
  const partial: TransactionModifyingSigner & TransactionPartialSigner = {
    address: addr,
    modifyAndSignTransactions: async (transactions) => {
      if (fail) throw fail;
      return transactions.map((tx) => ({ ...tx, signatures: { ...tx.signatures, [addr]: SIG_BYTES } }) as SignedTx);
    },
    signTransactions: async (transactions) => {
      if (fail) throw fail;
      return transactions.map(() => ({ [addr]: SIG_BYTES }));
    },
  };
  return partial;
}

/**
 * A send shaped like the SDK's (sendWithExecutor): the wallet signs through the
 * tracked signer, then the broadcast. `before`: thrown before the wallet is
 * asked; `wallet`: the wallet call throws; `after`: thrown once the wallet
 * handed the signed transaction back.
 */
function sdkShapedSend(throws: { before?: Error; wallet?: Error; after?: Error }) {
  return async (track: Track) => {
    const signer = track(walletSignerOf("partial", throws.wallet ?? null)) as TransactionModifyingSigner;
    if (throws.before) throw throws.before;
    await signer.modifyAndSignTransactions([UNSIGNED]);
    if (throws.after) throw throws.after;
    return SIG;
  };
}

describe("runDocumentAnchorFlow (the panel's send → confirm → record)", () => {
  function flow(outcome: SignatureOutcome, send: (track: Track) => Promise<unknown> = async () => SIG) {
    const calls: string[] = [];
    const errors: unknown[] = [];
    const recordFn = vi.fn<(pending: PendingAnchor) => Promise<void>>(async () => {
      calls.push("record");
    });
    const flowHooks: AnchorFlowHooks = {
      send: async (track) => {
        calls.push("send");
        return send(track);
      },
      onSendError: (err, uncertain) => {
        errors.push(err);
        calls.push(uncertain ? "sendError:uncertain" : "sendError:not-sent");
      },
      onSent: () => calls.push(`sent:${readPendingAnchor(detectNetwork(), SA) ? "saved" : "unsaved"}`),
      wait: async () => {
        calls.push("wait");
        return outcome;
      },
      onOutcome: (_pending, o) => calls.push(`outcome:${o}`),
      record: recordFn,
    };
    return {
      calls,
      errors,
      recordFn,
      run: () => runDocumentAnchorFlow({ reference: REFERENCE, sha256: SHA }, { network: detectNetwork(), signer: SA }, flowHooks),
    };
  }

  it("a send error before the wallet handed anything back: nothing saved, the review stays open (onSent never runs), nothing waited for or recorded", async () => {
    stubStorage();
    const f = flow("confirmed", async () => {
      throw new Error("Simulation refused");
    });
    await expect(f.run()).resolves.toBe("not-sent");
    expect(f.calls).toEqual(["send", "sendError:not-sent"]);
    expect(readPendingAnchor(detectNetwork(), SA)).toBeNull();
    expect(readUncertainSend(detectNetwork(), SA)).toBeNull();
    // The wallet's refusal.
    const refused = flow("confirmed", sdkShapedSend({ wallet: new Error("User rejected the request") }));
    await expect(refused.run()).resolves.toBe("not-sent");
    expect(refused.calls).toEqual(["send", "sendError:not-sent"]);
    expect(readUncertainSend(detectNetwork(), SA)).toBeNull();
  });

  it.each([
    ["an empty signature", ""],
    ["nothing", undefined],
    ["something else than a signature", { signature: SIG }],
  ])("the send resolved with %s: it was broadcast, so may have been sent (never 'nothing was anchored')", async (_label, value) => {
    stubStorage();
    const f = flow("confirmed", async () => value);
    await expect(f.run()).resolves.toBe("uncertain");
    expect(f.calls).toEqual(["send", "sendError:uncertain"]);
    expect((f.errors[0] as Error).message).toBe("The wallet returned no transaction signature.");
    expect(readUncertainSend(detectNetwork(), SA)).toMatchObject({ reference: REFERENCE, sha256: SHA, signer: SA, signature: null });
    expect(readPendingAnchor(detectNetwork(), SA)).toBeNull();
    expect(f.recordFn).not.toHaveBeenCalled();
  });

  it("TransactionWalletChangedError decides nothing by itself: before the prompt or in the wallet call, nothing was sent; after the wallet handed the transaction back, may have been sent", async () => {
    stubStorage();
    // The verified client's check before the prompt.
    const before = flow("confirmed", sdkShapedSend({ before: new TransactionWalletChangedError() }));
    await expect(before.run()).resolves.toBe("not-sent");
    // The guarded session's check when the wallet returns: inside the wallet call, so the SDK never got the transaction.
    const inWallet = flow("confirmed", sdkShapedSend({ wallet: new TransactionWalletChangedError() }));
    await expect(inWallet.run()).resolves.toBe("not-sent");
    expect(readUncertainSend(detectNetwork(), SA)).toBeNull();
    // The verified client's check after the broadcast (wrapped or not).
    const after = flow("confirmed", sdkShapedSend({ after: new Error("send failed", { cause: new TransactionWalletChangedError() }) }));
    await expect(after.run()).resolves.toBe("uncertain");
    expect(after.calls).toEqual(["send", "sendError:uncertain"]);
    expect(readUncertainSend(detectNetwork(), SA)).toMatchObject({ signature: SIG });
  });

  it("a transport failure or timeout after the wallet signed: may have been sent; the warning keeps the transaction's id, nothing is waited for", async () => {
    for (const err of [new TypeError("fetch failed"), new DOMException("The operation was aborted due to timeout", "TimeoutError")]) {
      const store = stubStorage();
      const f = flow("confirmed", sdkShapedSend({ after: err }));
      await expect(f.run()).resolves.toBe("uncertain");
      expect(f.calls).toEqual(["send", "sendError:uncertain"]);
      const kept = readUncertainSend(detectNetwork(), SA);
      expect(kept).toMatchObject({ reference: REFERENCE, sha256: SHA, network: detectNetwork(), signer: SA, signature: SIG });
      expect(Date.parse(kept!.at)).not.toBeNaN();
      expect(store.has(PENDING_KEY)).toBe(false);
    }
  });

  it("a wallet that sends itself and fails may have broadcast first: may have been sent, no signature known", async () => {
    stubStorage();
    const f = flow("confirmed", async (track) => {
      const signer = track(walletSignerOf("send", new Error("The wallet could not send the transaction."))) as TransactionSendingSigner;
      return signer.signAndSendTransactions([UNSIGNED]);
    });
    await expect(f.run()).resolves.toBe("uncertain");
    expect(readUncertainSend(detectNetwork(), SA)).toMatchObject({ signature: null });
  });

  it("a signer that cannot sign is refused before the wallet: nothing was sent", async () => {
    stubStorage();
    const f = flow("confirmed", async (track) => track({ address: address(SA) } as TransactionSigner));
    await expect(f.run()).resolves.toBe("not-sent");
    expect((f.errors[0] as Error).message).toBe("This wallet cannot sign transactions.");
  });

  it("failed on the network: the pending anchor is forgotten, nothing recorded", async () => {
    stubStorage();
    const f = flow("failed");
    await expect(f.run()).resolves.toBe("failed");
    expect(f.calls).toEqual(["send", "sent:saved", "wait", "outcome:failed"]);
    expect(readPendingAnchor(detectNetwork(), SA)).toBeNull();
    expect(f.recordFn).not.toHaveBeenCalled();
  });

  it.each(["timeout", "unknown"] as const)("%s: the pending anchor is kept to be recorded from the card, nothing recorded yet", async (outcome) => {
    stubStorage();
    const f = flow(outcome);
    await expect(f.run()).resolves.toBe(outcome);
    expect(f.calls).toEqual(["send", "sent:saved", "wait", `outcome:${outcome}`]);
    expect(readPendingAnchor(detectNetwork(), SA)).toEqual(pendingOf());
    expect(f.recordFn).not.toHaveBeenCalled();
    const card = resultOf({ outcome });
    expect(anchorResultView(card)).toMatchObject({ heading: "Sent — not confirmed yet", canRecord: true, dismissLabel: null });
    expect(anchorBlocksNewSend(card)).toBe(true);
  });

  it("confirmed: the outcome is reported (the panel clears its inputs), then the anchor is recorded", async () => {
    stubStorage();
    const f = flow("confirmed");
    await expect(f.run()).resolves.toBe("confirmed");
    expect(f.calls).toEqual(["send", "sent:saved", "wait", "outcome:confirmed", "record"]);
    expect(f.recordFn).toHaveBeenCalledWith(pendingOf());
  });

  it("the panel wires it so: the tracked signer is the memo's and the fee payer's; the review closes once sent or maybe sent, not when nothing was sent; inputs are cleared on confirmed only", () => {
    const panel = readFileSync(join(process.cwd(), "app/admin/platform/document-anchor-panel.tsx"), "utf8");
    const send = panel.slice(panel.indexOf("send: (track) =>"), panel.indexOf("onSendError:"));
    expect(send).toContain("const signer = track(walletSigner(session));");
    expect(send).toContain("documentAnchorInstruction({ ...input, signer })");
    expect(send).toContain("feePayer: signer");
    const onSendError = panel.slice(panel.indexOf("onSendError:"), panel.indexOf("onSent:"));
    // Closed only when the anchor may be on chain (never "Nothing was anchored" then); open on any other send error.
    const mayHaveLanded = onSendError.slice(onSendError.indexOf("if (uncertainSend) {"), onSendError.indexOf("} else {"));
    expect(mayHaveLanded).toContain("setConfirmOpen(false)");
    expect(mayHaveLanded).toContain("setUncertain(uncertainSend)");
    expect(mayHaveLanded).toContain("The anchor may have been sent");
    expect(mayHaveLanded).toContain("Check the explorer for your wallet before you send it again.");
    expect(mayHaveLanded).not.toContain("Nothing was anchored");
    const otherwise = onSendError.slice(onSendError.indexOf("} else {"));
    expect(otherwise).toContain("Nothing was anchored");
    expect(otherwise).not.toContain("setConfirmOpen");
    const onSent = panel.slice(panel.indexOf("onSent:"), panel.indexOf("wait:"));
    expect(onSent).toContain("setConfirmOpen(false)");
    const onOutcome = panel.slice(panel.indexOf("onOutcome:"), panel.indexOf("      record,\n"));
    // Both early returns (failed; timeout / unknown) come before the inputs are cleared.
    expect(onOutcome.indexOf('setReferenceInput("")')).toBeGreaterThan(onOutcome.lastIndexOf("return;"));
    expect(onOutcome.match(/return;/g)).toHaveLength(2);
  });
});

describe("createAnchorSendTracker (where a send got)", () => {
  it("a wallet that only signs: before-wallet → wallet-signing while it is asked → signed, with the fee payer's signature; returned once the send resolved", async () => {
    for (const method of ["modifyAndSignTransactions", "signTransactions"] as const) {
      const tracker = createAnchorSendTracker();
      expect(tracker.stage).toBe("before-wallet");
      const seen: string[] = [];
      const inner = walletSignerOf("partial") as TransactionModifyingSigner & TransactionPartialSigner;
      const observed = {
        address: inner.address,
        modifyAndSignTransactions: async (txs: readonly SignedTx[]) => {
          seen.push(tracker.stage);
          return inner.modifyAndSignTransactions(txs);
        },
        signTransactions: async (txs: readonly SignedTx[]) => {
          seen.push(tracker.stage);
          return inner.signTransactions(txs);
        },
      } as unknown as TransactionSigner;
      const signer = tracker.track(observed) as TransactionModifyingSigner & TransactionPartialSigner;
      // The same kinds of signer: kit picks the wallet's signTransaction path by them.
      expect(Object.keys(signer).sort()).toEqual(["address", "modifyAndSignTransactions", "signTransactions"]);
      expect(signer.address).toBe(SA);
      await (method === "modifyAndSignTransactions" ? signer.modifyAndSignTransactions([UNSIGNED]) : signer.signTransactions([UNSIGNED]));
      expect(seen).toEqual(["wallet-signing"]);
      expect(tracker.stage).toBe("signed");
      expect(tracker.signature).toBe(SIG);
      tracker.returned();
      expect(tracker.stage).toBe("returned");
    }
  });

  it("the wallet's refusal leaves it at wallet-signing, with no signature", async () => {
    const tracker = createAnchorSendTracker();
    const signer = tracker.track(walletSignerOf("partial", new Error("User rejected the request"))) as TransactionModifyingSigner;
    await expect(signer.modifyAndSignTransactions([UNSIGNED])).rejects.toThrow("User rejected");
    expect(tracker.stage).toBe("wallet-signing");
    expect(tracker.signature).toBeNull();
  });

  it("a wallet that sends itself: wallet-sending while it is asked, signed with its signature once it returns", async () => {
    const tracker = createAnchorSendTracker();
    const signer = tracker.track(walletSignerOf("send")) as TransactionSendingSigner;
    expect(Object.keys(signer).sort()).toEqual(["address", "signAndSendTransactions"]);
    await signer.signAndSendTransactions([UNSIGNED]);
    expect(tracker.stage).toBe("signed");
    expect(tracker.signature).toBe(SIG);
    const failing = createAnchorSendTracker();
    const refused = failing.track(walletSignerOf("send", new Error("The wallet could not send the transaction."))) as TransactionSendingSigner;
    await expect(refused.signAndSendTransactions([UNSIGNED])).rejects.toThrow();
    expect(failing.stage).toBe("wallet-sending");
    expect(failing.signature).toBeNull();
  });

  it("only moves forward", async () => {
    const tracker = createAnchorSendTracker();
    const signer = tracker.track(walletSignerOf("partial")) as TransactionModifyingSigner;
    await signer.modifyAndSignTransactions([UNSIGNED]);
    tracker.returned();
    await signer.modifyAndSignTransactions([UNSIGNED]);
    expect(tracker.stage).toBe("returned");
  });

  it("may have been sent: from the moment a wallet that sends itself is asked, or a signing wallet handed the transaction back", () => {
    expect(anchorSendMayHaveLanded("before-wallet")).toBe(false);
    expect(anchorSendMayHaveLanded("wallet-signing")).toBe(false);
    expect(anchorSendMayHaveLanded("wallet-sending")).toBe(true);
    expect(anchorSendMayHaveLanded("signed")).toBe(true);
    expect(anchorSendMayHaveLanded("returned")).toBe(true);
  });
});

describe("the send that may have been sent, kept in this browser", () => {
  const keyOf = (network: Network, signer: string) => `${UNCERTAIN_KEY}:${network}:${signer}`;

  it("is kept per network and wallet, next to the pending anchor (never in its place), and forgotten only for its own", () => {
    const store = stubStorage();
    const other: Network = detectNetwork() === "mainnet" ? "devnet" : "mainnet";
    saveUncertainSend(uncertainOf());
    saveUncertainSend(uncertainOf({ signer: ADMIN }));
    saveUncertainSend(uncertainOf({ network: other }));
    expect(store.has(keyOf(detectNetwork(), SA))).toBe(true);
    expect(store.has(PENDING_KEY)).toBe(false);
    expect(readUncertainSend(detectNetwork(), SA)).toEqual(uncertainOf());
    expect(readUncertainSend(detectNetwork(), ADMIN)).toEqual(uncertainOf({ signer: ADMIN }));
    expect(readUncertainSend(other, SA)).toEqual(uncertainOf({ network: other }));
    clearUncertainSend(detectNetwork(), ADMIN);
    expect(readUncertainSend(detectNetwork(), ADMIN)).toBeNull();
    expect(readUncertainSend(detectNetwork(), SA)).toEqual(uncertainOf());
    expect(readUncertainSend(other, SA)).not.toBeNull();
    // Without a signature (a wallet that sends itself) it is kept too.
    saveUncertainSend(uncertainOf({ signature: null }));
    expect(readUncertainSend(detectNetwork(), SA)?.signature).toBeNull();
  });

  it("ignores a damaged or foreign entry, and storage that is unavailable", () => {
    const store = stubStorage();
    const key = keyOf(detectNetwork(), SA);
    for (const bad of [
      "{not json",
      "null",
      JSON.stringify(uncertainOf({ signer: ADMIN })),
      JSON.stringify(uncertainOf({ signature: "javascript:alert(1)" })),
      JSON.stringify(uncertainOf({ at: "yesterday" })),
      JSON.stringify(uncertainOf({ sha256: "abc" })),
      JSON.stringify(uncertainOf({ reference: "has space" })),
    ]) {
      store.set(key, bad);
      expect(readUncertainSend(detectNetwork(), SA)).toBeNull();
    }
    vi.unstubAllGlobals();
    // No window or blocked storage: nothing read, nothing thrown.
    expect(readUncertainSend(detectNetwork(), SA)).toBeNull();
    expect(() => saveUncertainSend(uncertainOf())).not.toThrow();
    expect(() => clearUncertainSend(detectNetwork(), SA)).not.toThrow();
  });

  it("is shown on mount (a reload, or switching back to this wallet) and blocks a new send until it is dismissed", () => {
    stubStorage();
    hooks.wallet = SA;
    saveUncertainSend(uncertainOf());
    const markup = render(SA);
    expect(markup).toContain("The anchor may have been sent");
    expect(markup).toContain("Check the explorer for your wallet before you send it again");
    expect(markup).toContain(`href="${explorerAddressUrl(SA, detectNetwork())}"`);
    expect(markup).toContain(`href="${explorerTxUrl(SIG, detectNetwork())}"`);
    expect(markup).toContain("It is on the explorer: record it");
    expect(markup).toContain("It is not there: dismiss");
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>Review and anchor<\/button>/);
    // Not the card's "record it first" message: there is no card.
    expect(markup).not.toContain("not recorded in the audit log yet");
    // Without a signature: only the wallet's transactions, and only dismissing.
    saveUncertainSend(uncertainOf({ signature: null }));
    const bare = render(SA);
    expect(bare).toContain("Checked: dismiss");
    expect(bare).not.toContain("record it");
    expect(bare).not.toContain("/tx/");
    // Another wallet's warning is not this panel's.
    clearUncertainSend(detectNetwork(), SA);
    saveUncertainSend(uncertainOf({ signer: ADMIN }));
    expect(render(SA)).not.toContain("may have been sent");
  });

  it("'record it' makes it this browser's pending anchor, for the card to record, and forgets the warning; nothing changes without a signature", () => {
    const store = stubStorage();
    saveUncertainSend(uncertainOf());
    const adopted = adoptUncertainSend(uncertainOf());
    expect(adopted).toEqual({ anchor: pendingOf(), memo: `${REFERENCE} sha256:${SHA}`, outcome: "restored", record: null, recordError: null });
    expect(readPendingAnchor(detectNetwork(), SA)).toEqual(pendingOf());
    expect(readUncertainSend(detectNetwork(), SA)).toBeNull();
    expect(anchorBlocksNewSend(adopted)).toBe(true);
    store.clear();
    saveUncertainSend(uncertainOf({ signature: null }));
    expect(adoptUncertainSend(uncertainOf({ signature: null }))).toBeNull();
    expect(readUncertainSend(detectNetwork(), SA)).not.toBeNull();
    expect(store.has(PENDING_KEY)).toBe(false);
  });

  it("the panel restores it, blocks on it, dismisses only its own network and wallet, and records through the card", () => {
    const panel = readFileSync(join(process.cwd(), "app/admin/platform/document-anchor-panel.tsx"), "utf8");
    expect(panel).toContain("useState<UncertainAnchorSend | null>(() => readUncertainSend(network, wallet))");
    expect(panel).toContain("const blocked = anchorBlocksNewSend(result, uncertain);");
    expect(panel).toContain("if (working || blocked || !memo || !sha256 || !reference) return;");
    expect(panel).toContain("disabled={!memo || working || hashing || blocked}");
    expect(panel).toContain("clearUncertainSend(network, wallet);");
    const recordUncertain = panel.slice(panel.indexOf("function recordUncertain("), panel.indexOf("async function anchor()"));
    expect(recordUncertain).toContain("const adopted = adoptUncertainSend(note);");
    expect(recordUncertain).toContain("setResult(adopted);");
    expect(recordUncertain).toContain("void record(adopted.anchor);");
  });
});

describe("the result card", () => {
  it("offers what each state allows", () => {
    expect(anchorResultView(resultOf({ outcome: null }))).toMatchObject({ heading: "Sent — waiting for the network", canRecord: false, dismissLabel: null, tone: "pending" });
    expect(anchorResultView(resultOf({ outcome: "restored" }))).toMatchObject({ heading: "Sent earlier from this browser, not recorded yet", canRecord: true, dismissLabel: null });
    expect(anchorResultView(resultOf({ outcome: "failed" }))).toMatchObject({ heading: "The anchor failed on the network", canRecord: false, dismissLabel: "Done", tone: "failed" });
    expect(anchorResultView(resultOf({ outcome: "confirmed" }))).toMatchObject({ heading: "Anchored on chain", canRecord: true, tone: "confirmed" });
    expect(anchorResultView(resultOf({ outcome: "timeout", recordError: "Not recorded: …" }))).toMatchObject({ canRecord: true, dismissLabel: "Forget it" });
  });

  it("'Forget it' says what is lost: a confirmed anchor stays on chain unrecorded; otherwise check the explorer first", () => {
    const confirmed = anchorResultView(resultOf({ outcome: "confirmed", recordError: "Audit log unavailable" }));
    expect(confirmed).toMatchObject({ heading: "Anchored on chain", canRecord: true, dismissLabel: "Forget it", dismissWarning: FORGET_CONFIRMED_WARNING });
    expect(FORGET_CONFIRMED_WARNING).toMatch(/is on chain/);
    expect(FORGET_CONFIRMED_WARNING).toMatch(/cannot record it later/);
    for (const outcome of ["timeout", "unknown", "restored"] as const) {
      expect(anchorResultView(resultOf({ outcome, recordError: "Not recorded" }))).toMatchObject({
        dismissLabel: "Forget it",
        dismissWarning: FORGET_UNCONFIRMED_WARNING,
      });
    }
    expect(FORGET_UNCONFIRMED_WARNING).toMatch(/only when the explorer does not show this transaction/);
    // No warning without "Forget it".
    expect(anchorResultView(resultOf({ outcome: "confirmed" })).dismissWarning).toBeNull();
    expect(anchorResultView(resultOf({ outcome: "failed" })).dismissWarning).toBeNull();
    expect(anchorResultView(resultOf({ outcome: "confirmed", record: recorded })).dismissWarning).toBeNull();
    // The card shows it.
    const panel = readFileSync(join(process.cwd(), "app/admin/platform/document-anchor-panel.tsx"), "utf8");
    expect(panel).toContain("{view.dismissWarning && <p");
  });

  it("a successful record after a timeout, an unknown status or a restore shows 'Anchored on chain' (the server read it finalized)", () => {
    for (const outcome of ["timeout", "unknown", "restored", null] as const) {
      const after = withRecordedAnchor(resultOf({ outcome, recordError: "earlier failure" }), recorded);
      expect(after).toMatchObject({ outcome: "confirmed", record: recorded, recordError: null });
      expect(anchorResultView(after)).toEqual({ heading: "Anchored on chain", tone: "confirmed", canRecord: false, dismissLabel: "Done", dismissWarning: null });
      expect(anchorBlocksNewSend(after)).toBe(false);
    }
  });

  it("blocks a new send while an anchor may be on chain unrecorded; not after a failure or a record", () => {
    expect(anchorBlocksNewSend(null)).toBe(false);
    for (const outcome of [null, "restored", "timeout", "unknown", "confirmed"] as const) {
      expect(anchorBlocksNewSend(resultOf({ outcome }))).toBe(true);
    }
    expect(anchorBlocksNewSend(resultOf({ outcome: "failed" }))).toBe(false);
    expect(anchorBlocksNewSend(resultOf({ outcome: "confirmed", record: recorded }))).toBe(false);
    // A send that may have been sent blocks whatever the card shows, until it is dismissed.
    expect(anchorBlocksNewSend(null, uncertainOf())).toBe(true);
    expect(anchorBlocksNewSend(resultOf({ outcome: "failed" }), uncertainOf({ signature: null }))).toBe(true);
    expect(anchorBlocksNewSend(resultOf({ outcome: "confirmed", record: recorded }), uncertainOf())).toBe(true);
    expect(anchorBlocksNewSend(null, null)).toBe(false);
  });

  it("'Forget it' forgets the card's pending anchor only; 'Done' after a record leaves storage alone", () => {
    const store = stubStorage();
    savePendingAnchor(pendingOf());
    dismissAnchorResult(resultOf({ outcome: "timeout", recordError: "Not recorded" }));
    expect(store.has(PENDING_KEY)).toBe(false);
    const SIG2 = "3vSXmWYxioJaTwCRytEr7xHDKinyJ35UMYie4mNdMceH8ncu2V3qCQ8VexzhMbLV3KUv1s7jhAdHR8YBdVEV5YUJ";
    savePendingAnchor(pendingOf({ signature: SIG2 }));
    dismissAnchorResult(resultOf({ outcome: "timeout", recordError: "Not recorded" }));
    expect(readPendingAnchor(detectNetwork(), SA)?.signature).toBe(SIG2);
    dismissAnchorResult(resultOf({ outcome: "confirmed", record: recorded }));
    expect(readPendingAnchor(detectNetwork(), SA)?.signature).toBe(SIG2);
  });
});

describe("sha256HexOfFile (the file is hashed in the browser, never uploaded)", () => {
  it("matches known SHA-256 values", async () => {
    expect(await sha256HexOfFile(new File([], "empty.pdf"))).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(await sha256HexOfFile(new File(["abc"], "abc.txt"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    const bytes = new Uint8Array(200_000).map((_, i) => (i * 31 + 7) % 256);
    expect(await sha256HexOfFile(new File([bytes], "doc.pdf"))).toBe(createHash("sha256").update(bytes).digest("hex"));
  });
});
