import type { SolanaClient } from "@solana/client";
import type { Address } from "@solana/kit";
import { describe, expect, it, vi } from "vitest";
import type { ConversionStatus } from "@/lib/conversion";
import {
  conversionBalances,
  conversionRequestGate,
  conversionRowsLive,
  HOLDER_CONVERSION_MIN_GAP_MS,
  HOLDER_CONVERSION_POLL_MS,
  isOpenConversionStatus,
  latestConversionRead,
  loadConversionBalances,
  nextConversionStep,
  shouldPollConversions,
  sortConversionRequests,
  validConversionAmount,
  type ConversionKycVerdict,
} from "@/lib/conversion-holder";

const token = (account: string, mint: string, amount: string) => ({
  pubkey: account, account: { data: { parsed: { info: { mint, tokenAmount: { amount } } } } },
});

describe("holder conversion eligibility", () => {
  it("sums separate token accounts of one mint and excludes zero balances", () => {
    const balances = conversionBalances([
      token("ata", "equity", "12"), token("other-account", "equity", "8"),
      token("zero", "not-held", "0"), token("other-mint", "other", "2"),
    ]);
    expect([...balances]).toEqual([["equity", BigInt(20)], ["other", BigInt(2)]]);
  });

  it("does not count a repeated token account twice and preserves bigint precision", () => {
    const entry = token("account", "mint", "9007199254740993");
    expect(conversionBalances([entry, entry]).get("mint")).toBe(BigInt("9007199254740993"));
  });

  it.each(["-1", "1.5", "bad", ""])("fails closed on an unreadable token amount %j instead of returning a partial total", (amount) => {
    expect(() => conversionBalances([token("valid", "mint", "12"), token("invalid", "mint", amount)])).toThrow("Could not verify");
  });

  it("distinguishes an empty wallet from an RPC failure", async () => {
    const send = vi.fn().mockResolvedValue({ value: [] });
    const accounts = vi.fn(() => ({ send }));
    const rpc = { getTokenAccountsByOwner: accounts } as unknown as SolanaClient["runtime"]["rpc"];
    const owner = "11111111111111111111111111111111" as Address;
    expect((await loadConversionBalances(rpc, owner)).size).toBe(0);
    expect(accounts).toHaveBeenCalledWith(owner, { programId: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" }, { encoding: "jsonParsed" });
    send.mockRejectedValue(new Error("RPC unavailable"));
    await expect(loadConversionBalances(rpc, owner)).rejects.toThrow("RPC unavailable");
  });

  it("ignores an older ownership result after a newer refresh has started", async () => {
    const reads = latestConversionRead();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const first = reads.begin(() => true);
    let value = "loading";
    const oldResult = pending.then(() => { if (first()) value = "old holdings"; });
    const latest = reads.begin(() => true);
    if (latest()) value = "new holdings";
    release();
    await oldResult;
    expect(value).toBe("new holdings");
  });

  it("rejects a pending KYC/requests result after wallet or network changes, or unmount", () => {
    const reads = latestConversionRead();
    let current = "devnet:wallet-A";
    const result = reads.begin(() => current === "devnet:wallet-A");
    expect(result()).toBe(true);
    current = "devnet:wallet-B";
    expect(result()).toBe(false);
    current = "mainnet:wallet-A";
    expect(result()).toBe(false);
    current = "devnet:wallet-A";
    reads.invalidate();
    expect(result()).toBe(false);
  });

  it("accepts only positive safely representable amounts within the current balance", () => {
    expect(validConversionAmount("20", BigInt(20))).toBe(true);
    expect(validConversionAmount("21", BigInt(20))).toBe(false);
    for (const amount of ["", "0", "-1", "1.5", "1e2", "9007199254740992"]) {
      expect(validConversionAmount(amount, BigInt("9007199254740993"))).toBe(false);
    }
    expect(validConversionAmount(String(Number.MAX_SAFE_INTEGER), BigInt("9007199254740993"))).toBe(true);
  });
});

// ── Row order, liveness and the holder's next step ─────────────────────────

const at = (iso: string, status: ConversionStatus, id = `${status}-${iso}`) => ({ id, status, created_at: iso });

describe("holder row order and next step", () => {
  it("puts the open escrow first, then what Manci reviews, then deposits, then history; newest first within a group", () => {
    const rows = [
      at("2026-10-16T12:00:00Z", "converted"),
      at("2026-10-15T12:00:00Z", "requested", "r-old"),
      at("2026-10-14T12:00:00Z", "vault_opened"),
      at("2026-10-16T09:00:00Z", "requested", "r-new"),
      at("2026-10-13T12:00:00Z", "deposited"),
      at("2026-10-12T12:00:00Z", "cancelled"),
      at("2026-10-11T12:00:00Z", "returned"),
    ];
    expect(sortConversionRequests(rows).map((r) => r.id)).toEqual([
      "vault_opened-2026-10-14T12:00:00Z", "r-new", "r-old", "deposited-2026-10-13T12:00:00Z",
      "converted-2026-10-16T12:00:00Z", "cancelled-2026-10-12T12:00:00Z", "returned-2026-10-11T12:00:00Z",
    ]);
  });

  it("is stable (equal timestamps keep the server's order) and leaves the input as it was", () => {
    const rows = [
      at("2026-10-16T12:00:00Z", "requested", "a"),
      at("2026-10-16T12:00:00Z", "requested", "b"),
      at("2026-10-16T12:00:00Z", "vault_opened", "c"),
    ];
    expect(sortConversionRequests(rows).map((r) => r.id)).toEqual(["c", "a", "b"]);
    expect(rows.map((r) => r.id)).toEqual(["a", "b", "c"]);
  });

  it("names the one row to look at first, or none when nothing is in progress", () => {
    expect(nextConversionStep([])).toBeNull();
    expect(nextConversionStep([at("2026-10-16T12:00:00Z", "converted"), at("2026-10-15T12:00:00Z", "cancelled")])).toBeNull();
    const rows = [
      at("2026-10-16T12:00:00Z", "requested", "r"),
      at("2026-10-10T12:00:00Z", "vault_opened", "v"),
      at("2026-10-12T12:00:00Z", "deposited", "d"),
      at("2026-10-17T12:00:00Z", "converted", "done"),
    ];
    expect(nextConversionStep(rows)?.id).toBe("v");
    expect(nextConversionStep(rows.filter((r) => r.id !== "v"))?.id).toBe("r");
    expect(nextConversionStep(rows.filter((r) => r.id === "d" || r.id === "done"))?.id).toBe("d");
  });

  it("knows which rows still hold the holder's units", () => {
    for (const status of ["requested", "vault_opened", "deposited"]) expect(isOpenConversionStatus(status), status).toBe(true);
    for (const status of ["converted", "cancelled", "returned", "approved", ""]) expect(isOpenConversionStatus(status), status).toBe(false);
    expect(conversionRowsLive([])).toBe(false);
    expect(conversionRowsLive([{ status: "converted" }, { status: "cancelled" }])).toBe(false);
    expect(conversionRowsLive([{ status: "converted" }, { status: "deposited" }])).toBe(true);
  });
});

// ── Background polling ─────────────────────────────────────────────────────

describe("background re-list", () => {
  const base = { live: true, visible: true, busy: false, sessionLost: false, lastReadAt: 0, now: 60_000 };

  it("polls only a visible, idle page with a live session and a row in progress", () => {
    expect(shouldPollConversions(base)).toBe(true);
    expect(shouldPollConversions({ ...base, live: false })).toBe(false);
    expect(shouldPollConversions({ ...base, visible: false })).toBe(false);
    expect(shouldPollConversions({ ...base, busy: true })).toBe(false);
    expect(shouldPollConversions({ ...base, sessionLost: true })).toBe(false);
  });

  it("skips a refetch too soon after the last read (a tab flicker); the interval is longer than that gap", () => {
    expect(shouldPollConversions({ ...base, lastReadAt: 55_000 })).toBe(false);
    expect(shouldPollConversions({ ...base, lastReadAt: 50_000 })).toBe(true);
    expect(shouldPollConversions({ ...base, lastReadAt: 55_000, minGapMs: 1_000 })).toBe(true);
    expect(HOLDER_CONVERSION_POLL_MS).toBe(20_000);
    expect(HOLDER_CONVERSION_POLL_MS).toBeGreaterThan(HOLDER_CONVERSION_MIN_GAP_MS);
  });
});

// ── The request button's gate ──────────────────────────────────────────────

describe("the request button's gate", () => {
  const eligible: ConversionKycVerdict = { eligible: true, status: "verified", expired: false, message: null };
  const loaded = { requestsLoaded: true, listError: null, kyc: eligible, holdings: [{}], holdingsError: null };

  it("says nothing about tokens or verification while a read is still running", () => {
    expect(conversionRequestGate({ requestsLoaded: false, listError: null, kyc: undefined, holdings: null, holdingsError: null })).toEqual({ kind: "checking" });
    expect(conversionRequestGate({ ...loaded, requestsLoaded: false })).toEqual({ kind: "checking" });
    expect(conversionRequestGate({ ...loaded, kyc: undefined })).toEqual({ kind: "checking" });
    expect(conversionRequestGate({ ...loaded, holdings: null })).toEqual({ kind: "checking" });
  });

  it("asks for a sign-in only for a lost session; any other list failure is an error with its message", () => {
    expect(conversionRequestGate({ ...loaded, listError: { kind: "session", message: "No wallet session for this background read" } })).toEqual({ kind: "sign" });
    expect(conversionRequestGate({ ...loaded, requestsLoaded: false, listError: { kind: "error", message: "Request failed (502 Bad Gateway)" } })).toEqual({
      kind: "list-error", message: "Request failed (502 Bad Gateway)",
    });
  });

  it("a chain-read failure is a retry, never 'no tokens'", () => {
    expect(conversionRequestGate({ ...loaded, holdings: null, holdingsError: "Could not read your token holdings." })).toEqual({
      kind: "holdings-error", message: "Could not read your token holdings.",
    });
  });

  it("an unknown verdict asks for a retry; a refusal shows the server's message, with the compliance team for a terminal dossier", () => {
    expect(conversionRequestGate({ ...loaded, kyc: null })).toEqual({ kind: "kyc-unknown" });
    const pending: ConversionKycVerdict = {
      eligible: false, status: "pending", expired: false,
      message: 'KYC verification required before requesting a conversion — your current status is "pending".',
    };
    expect(conversionRequestGate({ ...loaded, kyc: pending })).toEqual({ kind: "verify", message: pending.message, status: "pending", contactCompliance: false });
    expect(conversionRequestGate({ ...loaded, kyc: { ...pending, status: "verified", expired: true, message: "KYC verification expired on 2000-01-01 — renew" } }))
      .toMatchObject({ kind: "verify", status: "verified", contactCompliance: false });
    for (const status of ["suspended", "rejected"]) {
      expect(conversionRequestGate({ ...loaded, kyc: { ...pending, status, message: "refused" } }), status).toMatchObject({ kind: "verify", message: "refused", contactCompliance: true });
    }
    // An older server without a message still gets a reason.
    expect(conversionRequestGate({ ...loaded, kyc: { eligible: false, status: null, expired: false, message: null } })).toMatchObject({
      kind: "verify", message: "KYC verification required before requesting a conversion.",
    });
  });

  it("enables the button only for an eligible holder with convertible tokens, once every read has answered", () => {
    expect(conversionRequestGate({ ...loaded, holdings: [] })).toEqual({ kind: "no-tokens" });
    expect(conversionRequestGate(loaded)).toEqual({ kind: "ready", count: 1 });
    expect(conversionRequestGate({ ...loaded, holdings: [{}, {}] })).toEqual({ kind: "ready", count: 2 });
  });
});
