// The holder's conversion client wrappers (lib/conversion.ts): the writes
// throw with the server's own message (a 409 "request changed", a 503 "not
// finalized" or a 403 refusal read as what they are), the list passes the
// interactive mode through to signedFetch (a timer's read never prompts) and
// parses the create gate's verdict, and create hands back the created row.
// signedFetch itself is covered by tests/siws-client*.test.ts.
import type { WalletSession } from "@solana/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const remote = vi.hoisted(() => ({ signedFetch: vi.fn(), notify: vi.fn() }));
vi.mock("@/lib/siws-client", () => ({ signedFetch: remote.signedFetch }));
vi.mock("@/lib/admin-badges-events", () => ({ notifyAdminBadges: remote.notify }));

import {
  adminListConversionRequests,
  adminUpdateConversionRequest,
  cancelConversionRequest,
  createConversionRequest,
  listMyConversionRequests,
  markConversionDeposited,
  type ConversionRequest,
} from "@/lib/conversion";

const session = { account: { address: "11111111111111111111111111111111" } } as unknown as WalletSession;

const row: ConversionRequest = {
  id: "req-1", created_at: "2026-10-16T10:00:00.000Z", updated_at: "2026-10-16T10:00:00.000Z",
  network: "devnet", holder_wallet: "11111111111111111111111111111111", client_id: "c1",
  share_class_pda: "3n1mQ6zsrVpQyzFCkr9qFVGgU3qHiHQeAvGtaVJk9oNr", mint: "4KcVAsHCdcCPpDxYPHV7ZLcTU1sfKZBLZTz3H1B5mMhx",
  asset_pda: null, asset_label: "Test asset · #0 · 1", amount: 10, contact: "holder@example.com", note: "",
  status: "requested", vault_pda: null, vault_id: null, admin_note: null, decided_by: null, decided_at: null,
  deposit_tx: null, outcome_tx: null,
};

afterEach(() => {
  remote.signedFetch.mockReset();
  remote.notify.mockReset();
});

describe("holder conversion client wrappers", () => {
  it("cancel throws the server's message verbatim and resolves on success", async () => {
    remote.signedFetch.mockRejectedValueOnce(new Error("Request can only be cancelled while requested (current: vault_opened)"));
    await expect(cancelConversionRequest(session, "req-1")).rejects.toThrow(
      "Request can only be cancelled while requested (current: vault_opened)",
    );
    remote.signedFetch.mockResolvedValueOnce({});
    await expect(cancelConversionRequest(session, "req-1")).resolves.toBeUndefined();
    expect(remote.signedFetch).toHaveBeenLastCalledWith(session, "/api/conversion/cancel", "conversion.cancel", { id: "req-1" });
  });

  it("mark-deposited throws the server's message verbatim, retryable or not", async () => {
    for (const message of [
      "Transaction is not finalized or not yet available; retry recording without sending funds again",
      "Deposit recording requires an opened vault",
    ]) {
      remote.signedFetch.mockRejectedValueOnce(new Error(message));
      await expect(markConversionDeposited(session, "req-1", "sig")).rejects.toThrow(message);
    }
    remote.signedFetch.mockResolvedValueOnce({});
    await expect(markConversionDeposited(session, "req-1", "sig")).resolves.toBeUndefined();
    expect(remote.signedFetch).toHaveBeenLastCalledWith(
      session, "/api/conversion/deposited", "conversion.deposited", { id: "req-1", deposit_tx: "sig" },
    );
  });

  it("the holder's list passes the interactive mode through and parses the gate's verdict", async () => {
    const verdict = {
      eligible: false, status: "pending", expired: false,
      message: 'KYC verification required before requesting a conversion — your current status is "pending".',
    };
    remote.signedFetch.mockResolvedValueOnce({ requests: [row], kyc: verdict, kyc_status: "pending" });
    const result = await listMyConversionRequests(session);
    expect(remote.signedFetch).toHaveBeenLastCalledWith(
      session, "/api/conversion/list-mine", "conversion.listMine", {}, { interactive: true },
    );
    expect(result).toEqual({ requests: [row], kyc: verdict, kycStatus: "pending" });

    for (const interactive of [false, "session-only"] as const) {
      // A failed server-side lookup (or an older server) carries no verdict.
      remote.signedFetch.mockResolvedValueOnce({ requests: [], kyc: null, kyc_status: null });
      expect(await listMyConversionRequests(session, { interactive })).toEqual({ requests: [], kyc: null, kycStatus: null });
      expect(remote.signedFetch).toHaveBeenLastCalledWith(
        session, "/api/conversion/list-mine", "conversion.listMine", {}, { interactive },
      );
    }
    // A verdict without the boolean is no verdict.
    remote.signedFetch.mockResolvedValueOnce({ requests: [], kyc: { status: "verified" }, kyc_status: "verified" });
    expect((await listMyConversionRequests(session)).kyc).toBeNull();
  });

  it("a background read's session error comes through unchanged, so the page can offer a sign-in", async () => {
    const error = new Error("No wallet session for this background read");
    error.name = "WalletSessionRequiredError";
    remote.signedFetch.mockRejectedValueOnce(error);
    await expect(listMyConversionRequests(session, { interactive: false })).rejects.toBe(error);
  });

  it("create returns the id and the created row only when it has the shape the page renders", async () => {
    const input = {
      share_class_pda: row.share_class_pda, mint: row.mint, asset_pda: "AssetPda", asset_label: row.asset_label,
      amount: 10, contact: "holder@example.com",
    };
    remote.signedFetch.mockResolvedValueOnce({ id: "req-1", request: row });
    expect(await createConversionRequest(session, input)).toEqual({ id: "req-1", request: row });
    expect(remote.signedFetch).toHaveBeenLastCalledWith(session, "/api/conversion/create", "conversion.create", {
      share_class_pda: row.share_class_pda, mint: row.mint, asset_pda: "AssetPda", asset_label: row.asset_label,
      amount: 10, contact: "holder@example.com", note: "",
    });
    // An older server answers with the id alone; a bare id is not a row.
    remote.signedFetch.mockResolvedValueOnce({ id: "req-1" });
    expect(await createConversionRequest(session, input)).toEqual({ id: "req-1", request: null });
    remote.signedFetch.mockResolvedValueOnce({ id: "req-1", request: { id: "req-1" } });
    expect(await createConversionRequest(session, input)).toEqual({ id: "req-1", request: null });
    // The server's refusal is the error the form shows.
    remote.signedFetch.mockRejectedValueOnce(new Error(
      "You already have open conversion requests for 995 units of this share class; together with this request that exceeds your balance.",
    ));
    await expect(createConversionRequest(session, input)).rejects.toThrow("open conversion requests for 995 units");
  });

  it("the admin list keeps its call shape and takes the interactive mode last", async () => {
    remote.signedFetch.mockResolvedValue({ requests: [row] });
    expect(await adminListConversionRequests(session, "VaultPda")).toEqual([row]);
    expect(remote.signedFetch).toHaveBeenLastCalledWith(
      session, "/api/conversion/admin-list", "conversion.adminList", { vault_pda: "VaultPda" }, { interactive: true },
    );
    await adminListConversionRequests(session, undefined, { interactive: "session-only" });
    expect(remote.signedFetch).toHaveBeenLastCalledWith(
      session, "/api/conversion/admin-list", "conversion.adminList", {}, { interactive: "session-only" },
    );
  });

  it("the admin update still answers a boolean (app/admin/custody tests it) and notifies the badges only on success", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      remote.signedFetch.mockRejectedValueOnce(new Error("Funded custody must be returned before cancellation"));
      expect(await adminUpdateConversionRequest(session, "req-1", { status: "cancelled" })).toBe(false);
      expect(remote.notify).not.toHaveBeenCalled();
      remote.signedFetch.mockResolvedValueOnce({});
      expect(await adminUpdateConversionRequest(session, "req-1", { status: "cancelled" })).toBe(true);
      expect(remote.notify).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });
});
