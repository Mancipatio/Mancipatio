import { describe, expect, it } from "vitest";
import {
  getAddressEncoder,
  getProgramDerivedAddress,
  type Address,
} from "@solana/kit";
import {
  chooseClawbackPath,
  CLAWBACK_IX_NAME,
  checkSameKey,
  sameKeyHoldsBothRoles,
  sameKeyWarning,
  type PassportStatus,
} from "@/lib/clawback-path";
import { fetchBlockEntry } from "@/lib/blocklist";
import {
  getBlockEntryEncoder,
  TRANSFER_HOOK_PROGRAM_ADDRESS,
} from "@/lib/generated/transfer_hook";
import { explainSendError } from "@/lib/tx-error";

const HOLDER = "7Np41oeYqPefeNQEHSv1UDhYrehxin3NStELsSKCT4K2" as Address;
const OTHER = "5MZBGE68wKvzAiRnh9BLcxWzWZ9EGDgvS39mgLDLKTsy" as Address;
const BA = "8sHgqRqBEXaSkhcyzXtY3vBSfGqBbTeR2SkVFDcxrfd9" as Address;
const ADMIN = "6D6TgUKrYY6dJrCUZ6LcJKt5EGGdCUgHtVeUKmRZbUJ2" as Address;
const REGISTRY_PROGRAM =
  "FJs1EM1ND89L9sUXaS8VBKYXjmoXCkkVSJKRE19hmYxS" as Address;

describe("chooseClawbackPath", () => {
  const statuses: PassportStatus[] = ["revoked", "expired", "eligible", "missing"];

  it("covers the full decision matrix", () => {
    for (const hookConfigured of [false, true])
      for (const blocked of [false, true])
        for (const kycGated of [false, true])
          for (const entryStatus of statuses) {
            const path = chooseClawbackPath({
              blocked,
              hookConfigured,
              kycGated,
              entryStatus,
            });
            const label = JSON.stringify({ hookConfigured, blocked, kycGated, entryStatus });
            if (!hookConfigured) expect(path, label).toBeNull();
            else if (blocked) expect(path, label).toBe("blocklist");
            else if (kycGated && (entryStatus === "revoked" || entryStatus === "expired"))
              expect(path, label).toBe("kyc");
            else expect(path, label).toBeNull();
          }
  });

  it("an Open mint is clawed back only through the blocklist", () => {
    for (const entryStatus of statuses) {
      expect(
        chooseClawbackPath({ blocked: false, hookConfigured: true, kycGated: false, entryStatus }),
      ).toBeNull();
      expect(
        chooseClawbackPath({ blocked: true, hookConfigured: true, kycGated: false, entryStatus }),
      ).toBe("blocklist");
    }
  });

  it("names the on-chain instruction for the audit log", () => {
    expect(CLAWBACK_IX_NAME.blocklist).toBe("clawback_blocklisted_holder");
    expect(CLAWBACK_IX_NAME.kyc).toBe("clawback_from_holder");
  });

  it("warns when the Admin is the blocking key or the Blocklist Authority", () => {
    expect(sameKeyHoldsBothRoles(ADMIN, BA, BA)).toBe(false);
    expect(sameKeyHoldsBothRoles(ADMIN, ADMIN, BA)).toBe(true);
    expect(sameKeyHoldsBothRoles(ADMIN, BA, ADMIN)).toBe(true);
    expect(sameKeyHoldsBothRoles(null, null, null)).toBe(false);
    expect(sameKeyHoldsBothRoles(ADMIN, null, null)).toBe(false);
  });

  it("reports which key matched, and an unreadable Blocklist Authority", () => {
    expect(checkSameKey(ADMIN, BA, BA)).toEqual({
      asBlockedBy: false,
      asBlocklistAuthority: false,
    });
    expect(checkSameKey(ADMIN, ADMIN, BA)).toEqual({
      asBlockedBy: true,
      asBlocklistAuthority: false,
    });
    // Rotated authority: someone else added the entry, the Admin now holds BA.
    expect(checkSameKey(ADMIN, BA, ADMIN)).toEqual({
      asBlockedBy: false,
      asBlocklistAuthority: true,
    });
    expect(checkSameKey(ADMIN, BA, null)).toEqual({
      asBlockedBy: false,
      asBlocklistAuthority: null,
    });
    expect(checkSameKey(null, BA, BA)).toEqual({
      asBlockedBy: false,
      asBlocklistAuthority: false,
    });
  });

  it("words the same-key warning by which key matched", () => {
    expect(sameKeyWarning(checkSameKey(ADMIN, BA, BA))).toBeNull();
    expect(sameKeyWarning(checkSameKey(ADMIN, ADMIN, ADMIN))).toMatch(
      /same key as admin and blocked_by/,
    );
    const rotated = sameKeyWarning(checkSameKey(ADMIN, BA, ADMIN));
    expect(rotated).toMatch(/current Blocklist Authority/);
    expect(rotated).toMatch(/two different keys/);
    expect(rotated).not.toMatch(/same key as admin and blocked_by/);
    expect(sameKeyWarning(checkSameKey(ADMIN, BA, null))).toMatch(
      /could not be read/,
    );
    // The blocked_by match is known even when BA is unreadable.
    expect(sameKeyWarning(checkSameKey(ADMIN, ADMIN, null))).toMatch(
      /same key as admin and blocked_by/,
    );
  });
});

describe("fetchBlockEntry", () => {
  type Rpc = Parameters<typeof fetchBlockEntry>[0];
  async function blockPda(wallet: Address) {
    return (
      await getProgramDerivedAddress({
        programAddress: TRANSFER_HOOK_PROGRAM_ADDRESS,
        seeds: [new TextEncoder().encode("blocked"), getAddressEncoder().encode(wallet)],
      })
    )[0];
  }
  function rpcWith(address: Address, owner: Address | null, data: Uint8Array) {
    return {
      getAccountInfo: (requested: Address) => ({
        send: async () => ({
          context: { slot: BigInt(1) },
          value:
            owner && requested === address
              ? {
                  data: [Buffer.from(data).toString("base64"), "base64"],
                  owner,
                  executable: false,
                  lamports: BigInt(1),
                  space: BigInt(data.length),
                  rentEpoch: BigInt(0),
                }
              : null,
        }),
      }),
    } as unknown as Rpc;
  }
  const entry = (wallet: Address) =>
    new Uint8Array(getBlockEntryEncoder().encode({ wallet, addedBy: BA, bump: 254 }));

  it("returns the live entry and who added it", async () => {
    const pda = await blockPda(HOLDER);
    await expect(
      fetchBlockEntry(rpcWith(pda, TRANSFER_HOOK_PROGRAM_ADDRESS, entry(HOLDER)), HOLDER),
    ).resolves.toEqual({ pda, addedBy: BA });
  });

  it("treats a missing, foreign-owned, other-wallet or malformed account as not blocked", async () => {
    const pda = await blockPda(HOLDER);
    const bad = entry(HOLDER);
    bad[0] ^= 0xff;
    for (const rpc of [
      rpcWith(pda, null, entry(HOLDER)),
      rpcWith(pda, REGISTRY_PROGRAM, entry(HOLDER)),
      rpcWith(pda, TRANSFER_HOOK_PROGRAM_ADDRESS, entry(OTHER)),
      rpcWith(pda, TRANSFER_HOOK_PROGRAM_ADDRESS, bad),
      rpcWith(pda, TRANSFER_HOOK_PROGRAM_ADDRESS, entry(HOLDER).slice(0, 40)),
    ])
      await expect(fetchBlockEntry(rpc, HOLDER)).resolves.toBeNull();
  });

  it("propagates RPC failures instead of reporting 'not blocked'", async () => {
    const rpc = {
      getAccountInfo: () => ({
        send: async () => {
          throw new Error("offline");
        },
      }),
    } as unknown as Rpc;
    await expect(fetchBlockEntry(rpc, HOLDER)).rejects.toThrow("offline");
  });
});

describe("clawback tx-error hints", () => {
  const hint = (code: number) =>
    explainSendError(
      Object.assign(new Error("Transaction simulation failed"), {
        context: { logs: [`Program x failed: custom program error: 0x${code.toString(16)}`] },
      }),
    );

  it.each([
    [6079, /ClawbackHolderStillEligible/],
    [6080, /ClawbackNotKycGated/],
    [6081, /ClawbackDestinationInvalid/],
    [6087, /ClawbackTargetIsEscrow/],
    [6137, /ClawbackHolderNotBlocked/],
    [6138, /HookConfigInvalid/],
  ])("explains %i", (code, pattern) => {
    expect(hint(code)).toMatch(pattern);
  });

  it("6087 covers a blocked escrow, whose own exits are refused too", () => {
    expect(hint(6087)).toMatch(/remove it from the blocklist first/);
    expect(hint(6087)).toMatch(/block the recipient wallet instead/);
  });
});
