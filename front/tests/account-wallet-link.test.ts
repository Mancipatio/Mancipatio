import { describe, expect, it } from "vitest";
import type { AccountWalletLinkAttempt } from "@/lib/account";
import { restoreWalletLinkAttempt, serializeWalletLinkAttempt, validWalletLinkAttempt } from "@/lib/account-wallet-link";

const now = Date.parse("2026-09-20T10:00:00Z");
const attempt: AccountWalletLinkAttempt = {
  token: "t".repeat(43), account_id: "d4f88128-1b5f-4a03-baa2-6177840d31ab",
  requested_by: "11111111111111111111111111111111",
  target_wallet: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  expires_at: "2026-09-20T10:10:00Z",
};

describe("same-tab wallet link continuation", () => {
  it("restores the bounded attempt after a reload on the same network", () => {
    expect(restoreWalletLinkAttempt(serializeWalletLinkAttempt(attempt, "devnet"), "devnet", now)).toEqual(attempt);
  });

  it("does not restore an attempt from another network", () => {
    expect(restoreWalletLinkAttempt(serializeWalletLinkAttempt(attempt, "devnet"), "mainnet", now)).toBeNull();
  });

  it("drops expired attempts rather than resuming with a stale proof", () => {
    expect(restoreWalletLinkAttempt(serializeWalletLinkAttempt(attempt, "devnet"), "devnet", now + 10 * 60_000)).toBeNull();
  });

  it.each([
    { field: "token", patch: { token: "bad-token" } },
    { field: "account", patch: { account_id: "wallet-address" } },
    { field: "target", patch: { target_wallet: "not-a-wallet" } },
    { field: "source", patch: { requested_by: "not-a-wallet" } },
    { field: "same source and target", patch: { target_wallet: attempt.requested_by } },
    { field: "unbounded expiry", patch: { expires_at: "2026-10-20T10:10:00Z" } },
  ])("rejects a malformed or tampered $field", ({ patch }) => {
    expect(validWalletLinkAttempt({ ...attempt, ...patch }, now)).toBe(false);
  });

  it("never serializes private profile or signed-request fields", () => {
    const extra = { ...attempt, email: "private@example.com", display_name: "Private name", signature: "signed-envelope", profile: { secret: "private" } };
    const raw = serializeWalletLinkAttempt(extra, "devnet");
    expect(JSON.parse(raw)).toEqual({ network: "devnet", attempt });
    expect(raw).not.toContain("private");
    expect(raw).not.toContain("signature");
  });

  it("ignores invalid JSON and oversized storage values", () => {
    expect(restoreWalletLinkAttempt("{", "devnet", now)).toBeNull();
    expect(restoreWalletLinkAttempt("x".repeat(2001), "devnet", now)).toBeNull();
    expect(restoreWalletLinkAttempt(null, "devnet", now)).toBeNull();
  });
});
