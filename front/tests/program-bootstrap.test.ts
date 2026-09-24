import { describe, it, expect } from "vitest";
import {
  address,
  createNoopSigner,
  getAddressEncoder,
  getProgramDerivedAddress,
  type Address,
} from "@solana/kit";
import { ASSET_REGISTRY_PROGRAM_ADDRESS } from "@/lib/generated/asset_registry";
import { TRANSFER_HOOK_PROGRAM_ADDRESS } from "@/lib/generated/transfer_hook";
import {
  buildInitializePlatformInstruction,
  buildInitializeBlocklistAuthorityInstruction,
  bootstrapRoleErrors,
  MAINNET_BOOTSTRAP_REFUSAL,
  requireProgramUpgradeAuthority,
} from "@/lib/program-bootstrap";
const wallet = address("11111111111111111111111111111111"),
  signer = createNoopSigner(wallet),
  loader = address("BPFLoaderUpgradeab1e11111111111111111111111");
type Rpc = Parameters<typeof requireProgramUpgradeAuthority>[0];
async function fixture(program: Address) {
  const [pda] = await getProgramDerivedAddress({
    programAddress: loader,
    seeds: [getAddressEncoder().encode(program)],
  });
  const executable = new Uint8Array(36);
  new DataView(executable.buffer).setUint32(0, 2, true);
  executable.set(getAddressEncoder().encode(pda), 4);
  const programData = new Uint8Array(45);
  new DataView(programData.buffer).setUint32(0, 3, true);
  programData[12] = 1;
  programData.set(getAddressEncoder().encode(wallet), 13);
  const accounts: Record<
    string,
    { data: Uint8Array; owner: Address; executable: boolean }
  > = {
    [program]: { data: executable, owner: loader, executable: true },
    [pda]: { data: programData, owner: loader, executable: false },
  };
  const rpc = {
    getAccountInfo: (key: Address) => ({
      send: async () => {
        const a = accounts[key];
        return {
          context: { slot: BigInt(1) },
          value: a
            ? {
                data: [Buffer.from(a.data).toString("base64"), "base64"],
                owner: a.owner,
                executable: a.executable,
                lamports: BigInt(1),
                space: BigInt(a.data.length),
                rentEpoch: BigInt(0),
              }
            : null,
        };
      },
    }),
  } as unknown as Rpc;
  return { pda, rpc, accounts };
}
describe("upgrade-authority bootstrap builders", () => {
  it("appends the verified deployment proof to each program's real initializer", async () => {
    const registry = await fixture(ASSET_REGISTRY_PROGRAM_ADDRESS),
      hook = await fixture(TRANSFER_HOOK_PROGRAM_ADDRESS);
    const platform = await buildInitializePlatformInstruction(registry.rpc, {
      admin: signer,
      upgradeAuthority: signer,
      protocolTreasury: wallet,
      protocolFeeBps: 0,
    });
    expect(platform.accounts.map((a) => a.address).slice(4)).toEqual([
      wallet,
      ASSET_REGISTRY_PROGRAM_ADDRESS,
      registry.pda,
    ]);
    const blocklist = await buildInitializeBlocklistAuthorityInstruction(
      hook.rpc,
      { payer: signer, upgradeAuthority: signer, authority: wallet },
    );
    expect(blocklist.accounts.map((a) => a.address).slice(3)).toEqual([
      wallet,
      TRANSFER_HOOK_PROGRAM_ADDRESS,
      hook.pda,
    ]);
  });
  it("rejects other signers, immutable programs, wrong loader ownership and broken program-data links", async () => {
    for (const mode of ["signer", "immutable", "owner", "executable", "link"]) {
      const f = await fixture(ASSET_REGISTRY_PROGRAM_ADDRESS);
      if (mode === "immutable") f.accounts[f.pda].data[12] = 0;
      if (mode === "owner") f.accounts[f.pda].owner = wallet;
      if (mode === "executable")
        f.accounts[ASSET_REGISTRY_PROGRAM_ADDRESS].executable = false;
      if (mode === "link")
        f.accounts[ASSET_REGISTRY_PROGRAM_ADDRESS].data.fill(0, 4);
      await expect(
        requireProgramUpgradeAuthority(
          f.rpc,
          ASSET_REGISTRY_PROGRAM_ADDRESS,
          mode === "signer"
            ? createNoopSigner(TRANSFER_HOOK_PROGRAM_ADDRESS)
            : signer,
        ),
      ).rejects.toThrow(/upgrade-authority/);
    }
  });
});

describe("bootstrapRoleErrors (Talas 3.1 K2/K3)", () => {
  const UA = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
  const VAULT = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
  const OTHER = "Vote111111111111111111111111111111111111111";
  const DEFAULT = "11111111111111111111111111111111";
  const platform = (over: Partial<Parameters<typeof bootstrapRoleErrors>[0]> = {}) =>
    bootstrapRoleErrors({
      network: "devnet",
      surface: "browser",
      upgradeAuthority: UA,
      superAdmin: UA,
      treasury: VAULT,
      ...over,
    });
  const blocklist = (over: Partial<Parameters<typeof bootstrapRoleErrors>[0]> = {}) =>
    bootstrapRoleErrors({
      network: "devnet",
      surface: "browser",
      upgradeAuthority: UA,
      blocklistAuthority: UA,
      ...over,
    });

  it("refuses every browser bootstrap on mainnet, and nothing else there", () => {
    expect(platform({ network: "mainnet" })).toEqual({ errors: [MAINNET_BOOTSTRAP_REFUSAL], warnings: [] });
    expect(blocklist({ network: "mainnet" })).toEqual({ errors: [MAINNET_BOOTSTRAP_REFUSAL], warnings: [] });
    // The CLI surface is checked normally on mainnet.
    expect(platform({ network: "mainnet", surface: "cli" }).errors).toEqual([]);
    for (const network of ["devnet", "testnet", "localnet"] as const) {
      expect(platform({ network }).errors).toEqual([]);
    }
  });

  it("a clean browser platform init: the upgrade authority as Super Admin, an explicit treasury", () => {
    expect(platform()).toEqual({ errors: [], warnings: [] });
  });

  it("requires and validates the protocol treasury", () => {
    expect(platform({ treasury: "" }).errors).toContain("The protocol treasury is required.");
    expect(platform({ treasury: null }).errors).toContain("The protocol treasury is required.");
    expect(platform({ treasury: "not-a-key" }).errors.join(" ")).toMatch(/valid Solana address/);
    expect(platform({ treasury: DEFAULT }).errors.join(" ")).toMatch(/default/);
  });

  it("warns (without blocking) when the treasury is the upgrade authority or the Super Admin", () => {
    const ua = platform({ treasury: UA });
    expect(ua.errors).toEqual([]);
    expect(ua.warnings.join(" ")).toMatch(/upgrade-authority wallet.*Squads vault PDA \(K11\)/);
    const sa = platform({ surface: "cli", superAdmin: OTHER, treasury: OTHER });
    expect(sa.errors).toEqual([]);
    expect(sa.warnings.join(" ")).toMatch(/Super Admin wallet.*Squads vault PDA/);
  });

  it("the browser appoints only the connected upgrade authority; the CLI may name another key", () => {
    expect(platform({ superAdmin: OTHER }).errors.join(" ")).toMatch(/initial Super Admin is the connected upgrade authority/);
    expect(platform({ surface: "cli", superAdmin: OTHER }).errors).toEqual([]);
    expect(blocklist({ blocklistAuthority: OTHER }).errors.join(" ")).toMatch(/No browser path writes another key/);
    expect(blocklist({ surface: "cli", blocklistAuthority: OTHER }).errors).toEqual([]);
    expect(platform({ upgradeAuthority: null }).errors.join(" ")).toMatch(/upgrade-authority wallet/);
    expect(blocklist({ blocklistAuthority: DEFAULT, surface: "cli" }).errors.join(" ")).toMatch(/default/);
  });

  it("validates the optional permanent successors", () => {
    expect(platform({ permanentSuperAdmin: OTHER }).errors).toEqual([]);
    expect(platform({ permanentSuperAdmin: "  " }).errors).toEqual([]);
    expect(platform({ permanentSuperAdmin: UA }).errors.join(" ")).toMatch(/must differ/);
    expect(platform({ permanentSuperAdmin: DEFAULT }).errors.join(" ")).toMatch(/default/);
    expect(blocklist({ permanentBlocklistAuthority: OTHER }).errors).toEqual([]);
    expect(blocklist({ permanentBlocklistAuthority: UA }).errors.join(" ")).toMatch(/must differ/);
    expect(blocklist({ permanentBlocklistAuthority: "nope" }).errors.join(" ")).toMatch(/valid Solana address/);
  });
});
