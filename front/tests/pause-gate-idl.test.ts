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
  "open_custody_vault",
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

  it.each(GATED_EARLIER)("%s reads the Platform read-only", (name) => {
    const platform = byName.get(name)?.accounts.find((a) => a.name === "platform");
    expect(platform, name).toBeDefined();
    expect(platform!.writable ?? false).toBe(false);
  });

  // Package 2B: open_sale's approval accounts sit just before the Platform,
  // so every older account index and the Platform-last rule are unchanged.
  it("open_sale takes sale_approval and approved_by right before the Platform", () => {
    const names = byName.get("open_sale")!.accounts.map((a) => a.name);
    expect(names.slice(0, 10)).toEqual([
      "authority", "issuer", "asset", "share_class", "mint", "payment_mint",
      "sale", "proceeds", "payment_token_program", "system_program",
    ]);
    expect(names.at(-3)).toBe("sale_approval");
    expect(names.at(-2)).toBe("approved_by");
    const accounts = byName.get("open_sale")!.accounts;
    expect(accounts.at(-3)!.writable).toBe(true);
    expect(accounts.at(-2)!.writable).toBe(true);
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

  it("lets only the admin instructions write the Platform", () => {
    const writers = idl.instructions
      .filter((ix) => ix.accounts.some((a) => a.name === "platform" && a.writable))
      .map((ix) => ix.name)
      .sort();
    expect(writers).toEqual([...PLATFORM_WRITERS].sort());
  });
});
