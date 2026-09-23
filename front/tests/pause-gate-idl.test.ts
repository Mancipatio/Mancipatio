import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Every gated instruction reads the Platform READ-ONLY (so gated transactions
// never write-lock the singleton and contend with each other), and the 20
// that gained it in 2A carry it as the LAST named account (old account
// indices and remaining-accounts tails keep their positions). check:idl keeps
// this committed IDL identical to the one built from the Rust source.
type IdlAccount = { name: string; writable?: boolean; signer?: boolean };
type IdlInstruction = { name: string; accounts: IdlAccount[] };
const idl = JSON.parse(
  readFileSync(join(process.cwd(), "idl/asset_registry.json"), "utf8"),
) as { instructions: IdlInstruction[] };
const byName = new Map(idl.instructions.map((ix) => [ix.name, ix]));

const GATED_2A = [
  "buy",
  "claim_founder_yield",
  "close_sale",
  "create_distribution",
  "create_offer",
  "create_otc_deal",
  "create_rights_issuance",
  "deposit_otc_asset",
  "deposit_otc_payment",
  "deposit_to_custody_vault",
  "deposit_to_offer_escrow",
  "deposit_to_vesting_escrow",
  "distribute_batch",
  "initialize_share_class_mint",
  "mint_to_treasury",
  "open_sale",
  "publish_milestone",
  "release_payout",
  "take_offer",
];
/** Gated before 2A, with the Platform already in their accounts. */
const GATED_EARLIER = ["create_asset", "add_share_class", "route_yield"];
/** The only instructions that may write the Platform. */
const PLATFORM_WRITERS = [
  "accept_platform_admin",
  "initialize_platform",
  "register_issuer", // issuers_count
  "set_pause",
  "set_pause_flags",
  "set_protocol_treasury",
];

describe("emergency-pause gate in the committed IDL", () => {
  it.each(GATED_2A)("%s reads the Platform last and read-only", (name) => {
    const ix = byName.get(name);
    expect(ix, name).toBeDefined();
    const last = ix!.accounts.at(-1)!;
    expect(last.name).toBe("platform");
    expect(last.writable ?? false).toBe(false);
    expect(last.signer ?? false).toBe(false);
    expect(ix!.accounts.filter((a) => a.name === "platform")).toHaveLength(1);
  });

  // Package 2C-3 appends the optional KYC registry AFTER the Platform, so no
  // older account index moves: the Platform keeps index 9, read-only.
  it("open_custody_vault reads the Platform read-only at index 9, followed only by the optional KYC registry", () => {
    const accounts = byName.get("open_custody_vault")!.accounts;
    expect(accounts).toHaveLength(11);
    expect(accounts[9].name).toBe("platform");
    expect(accounts[9].writable ?? false).toBe(false);
    expect(accounts[9].signer ?? false).toBe(false);
    expect(accounts[10].name).toBe("kyc_registry");
    expect((accounts[10] as { optional?: boolean }).optional).toBe(true);
    expect(accounts[10].writable ?? false).toBe(false);
    expect(accounts.filter((a) => a.name === "platform")).toHaveLength(1);
  });

  it.each(GATED_EARLIER)("%s reads the Platform read-only", (name) => {
    const platform = byName.get(name)?.accounts.find((a) => a.name === "platform");
    expect(platform, name).toBeDefined();
    expect(platform!.writable ?? false).toBe(false);
  });

  // Package 2B: open_sale's approval accounts sit just before the Platform,
  // so every older account index and the Platform-last rule are unchanged.
  it("open_sale takes sale_approval, approved_by and the approver's Admin record right before the Platform", () => {
    const names = byName.get("open_sale")!.accounts.map((a) => a.name);
    expect(names.slice(0, 10)).toEqual([
      "authority", "issuer", "asset", "share_class", "mint", "payment_mint",
      "sale", "proceeds", "payment_token_program", "system_program",
    ]);
    expect(names.at(-4)).toBe("sale_approval");
    expect(names.at(-3)).toBe("approved_by");
    expect(names.at(-2)).toBe("approver_admin_record");
    const accounts = byName.get("open_sale")!.accounts;
    expect(accounts.at(-4)!.writable).toBe(true);
    expect(accounts.at(-3)!.writable).toBe(true);
    expect(accounts.at(-2)!.writable ?? false).toBe(false);
  });

  it.each(["approve_sale", "revoke_sale_approval"])(
    "%s is Admin-gated and never reads the Platform (not an entry flow)",
    (name) => {
      const ix = byName.get(name);
      expect(ix, name).toBeDefined();
      const names = ix!.accounts.map((a) => a.name);
      expect(names).toContain("admin_record");
      expect(names).toContain("sale_approval");
      expect(names).not.toContain("platform");
      expect(ix!.accounts.filter((a) => a.signer)).toHaveLength(1);
    },
  );

  it.each(["clawback_from_holder", "clawback_blocklisted_holder"])(
    "%s is Admin-gated, never reads the Platform and has one signer (enforcement stays open under a pause)",
    (name) => {
      const ix = byName.get(name);
      expect(ix, name).toBeDefined();
      const names = ix!.accounts.map((a) => a.name);
      expect(names).toContain("admin_record");
      expect(names).toContain("hook_config");
      expect(names).toContain("custody_vault");
      expect(names).not.toContain("platform");
      expect(ix!.accounts.filter((a) => a.signer)).toHaveLength(1);
    },
  );

  it("clawback_blocklisted_holder proves the block with the hook BlockEntry and takes no KYC accounts", () => {
    const names = byName
      .get("clawback_blocklisted_holder")!
      .accounts.map((a) => a.name);
    expect(names).toContain("block_entry");
    expect(names).not.toContain("kyc_registry");
    expect(names).not.toContain("kyc_entry");
    expect(byName.get("clawback_from_holder")!.accounts.map((a) => a.name)).not.toContain("block_entry");
  });

  it("lets only the admin instructions write the Platform", () => {
    const writers = idl.instructions
      .filter((ix) => ix.accounts.some((a) => a.name === "platform" && a.writable))
      .map((ix) => ix.name)
      .sort();
    expect(writers).toEqual([...PLATFORM_WRITERS].sort());
  });
});
