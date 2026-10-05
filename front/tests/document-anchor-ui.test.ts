// The "Anchor a document" panel on /admin/platform, rendered to static markup
// (no jsdom here): nothing for a wallet that is not the on-chain Super Admin
// (or no wallet), the panel for the Super Admin; the page mounts it with
// Platform.admin; a pending anchor kept in this browser is restored (for its
// network and signer only) and blocks a new send. The panel's send → confirm
// → record flow and its result card (lib/document-anchor-client.ts) are
// driven directly: what is saved, cleared, recorded and offered after each
// outcome, what "Forget it" warns about, and a send error that may have come
// after the broadcast. The page's recording retry: only "not yet" is retried.
// And the browser hash of a file against known SHA-256 values.
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
  anchorBlocksNewSend,
  anchorResultView,
  anchorSendMayHaveLanded,
  dismissAnchorResult,
  readPendingAnchor,
  recordDocumentAnchorWithRetry,
  restoredAnchorResult,
  runDocumentAnchorFlow,
  savePendingAnchor,
  withRecordedAnchor,
  type AnchorFlowHooks,
  type AnchorResult,
  type PendingAnchor,
  type RecordedAnchor,
} from "@/lib/document-anchor-client";
import { DOCUMENT_ANCHOR_NOT_YET } from "@/lib/document-anchor";
import { detectNetwork, type Network } from "@/lib/network";
import type { SignatureOutcome } from "@/lib/simulation-gate";
import { sha256HexOfFile } from "@/lib/storage-client";
import { TransactionWalletChangedError } from "@/lib/transaction-wallet-policy";

const render = (superAdmin: string) => renderToStaticMarkup(createElement(DocumentAnchorPanel, { superAdmin }));

const REFERENCE = "MANCI-2026-0001";
const SHA = "a2546dd318ea95b210a4eb62a45b84341d74fa065c3da1c1279fd62135f22bc7";
const SIG = "5RBDZNDobPiJGpQsfcvPLuSdzyUXRxBnpXNU4sFQg2ud3sTiSPyWnPrfvyN4myMYTvEUWjtYnGijuryNNrXqeDqm";
const PENDING_KEY = "manci:document-anchor:pending:v1";

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

describe("runDocumentAnchorFlow (the panel's send → confirm → record)", () => {
  function flow(outcome: SignatureOutcome, send: () => Promise<unknown> = async () => SIG) {
    const calls: string[] = [];
    const recordFn = vi.fn<(pending: PendingAnchor) => Promise<void>>(async () => {
      calls.push("record");
    });
    const flowHooks: AnchorFlowHooks = {
      send: async () => {
        calls.push("send");
        return send();
      },
      onSendError: () => calls.push("sendError"),
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
      recordFn,
      run: () => runDocumentAnchorFlow({ reference: REFERENCE, sha256: SHA }, { network: detectNetwork(), signer: SA }, flowHooks),
    };
  }

  it("a send error: nothing saved, the review stays open (onSent never runs), nothing waited for or recorded", async () => {
    stubStorage();
    const f = flow("confirmed", async () => {
      throw new Error("User rejected the request");
    });
    await expect(f.run()).resolves.toBe("not-sent");
    expect(f.calls).toEqual(["send", "sendError"]);
    expect(readPendingAnchor(detectNetwork(), SA)).toBeNull();
    // A wallet that returns no signature is a send error too.
    const empty = flow("confirmed", async () => "");
    await expect(empty.run()).resolves.toBe("not-sent");
    expect(empty.calls).toEqual(["send", "sendError"]);
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

  it("a send error after the wallet may have sent it (wallet, account or network changed) is told apart", () => {
    expect(anchorSendMayHaveLanded(new TransactionWalletChangedError())).toBe(true);
    // Wrapped by the SDK hook.
    expect(anchorSendMayHaveLanded(new Error("send failed", { cause: new TransactionWalletChangedError() }))).toBe(true);
    // Anything else came before the broadcast or from the wallet's refusal.
    expect(anchorSendMayHaveLanded(new Error("User rejected the request"))).toBe(false);
    expect(anchorSendMayHaveLanded(new Error("The wallet returned no transaction signature."))).toBe(false);
    expect(anchorSendMayHaveLanded("TransactionWalletChangedError")).toBe(false);
    expect(anchorSendMayHaveLanded(null)).toBe(false);
  });

  it("the panel wires it so: the review closes once sent, not on a send error; inputs are cleared on confirmed only", () => {
    const panel = readFileSync(join(process.cwd(), "app/admin/platform/document-anchor-panel.tsx"), "utf8");
    const onSendError = panel.slice(panel.indexOf("onSendError:"), panel.indexOf("onSent:"));
    // Closed only when the anchor may be on chain (never "Nothing was anchored" then); open on any other send error.
    const mayHaveLanded = onSendError.slice(onSendError.indexOf("if (anchorSendMayHaveLanded(err))"), onSendError.indexOf("} else {"));
    expect(mayHaveLanded).toContain("setConfirmOpen(false)");
    expect(mayHaveLanded).toContain("The anchor may have been sent");
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
