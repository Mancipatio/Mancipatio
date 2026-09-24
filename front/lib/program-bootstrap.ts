import {
  address,
  assertAccountExists,
  fetchEncodedAccount,
  getAddressDecoder,
  getAddressEncoder,
  getProgramDerivedAddress,
  isAddress,
  type Address,
  type TransactionSigner,
} from "@solana/kit";
import {
  ASSET_REGISTRY_PROGRAM_ADDRESS,
  getInitializePlatformInstructionAsync,
} from "@/lib/generated/asset_registry";
import {
  TRANSFER_HOOK_PROGRAM_ADDRESS,
  getInitializeBlocklistAuthorityInstructionAsync,
} from "@/lib/generated/transfer_hook";
import type { fetchMintTokenProgram } from "@/lib/transaction-builders";
import type { Network } from "@/lib/network";
import { DEFAULT_ADDRESS, protocolTreasuryError } from "@/lib/protocol-treasury";
const LOADER = address("BPFLoaderUpgradeab1e11111111111111111111111");
type Rpc = Parameters<typeof fetchMintTokenProgram>[0];
/** Mirrors the program's upgradeable-loader proof. Never reads local signer files. */
export async function requireProgramUpgradeAuthority(
  rpc: Rpc,
  program: Address,
  signer: TransactionSigner,
) {
  const [programData] = await getProgramDerivedAddress({
    programAddress: LOADER,
    seeds: [getAddressEncoder().encode(program)],
  });
  const [executable, data] = await Promise.all([
    fetchEncodedAccount(rpc, program, { commitment: "finalized" }),
    fetchEncodedAccount(rpc, programData, { commitment: "finalized" }),
  ]);
  assertAccountExists(executable);
  assertAccountExists(data);
  if (
    executable.programAddress !== LOADER ||
    !executable.executable ||
    executable.data.length !== 36 ||
    new DataView(
      executable.data.buffer,
      executable.data.byteOffset,
      executable.data.byteLength,
    ).getUint32(0, true) !== 2 ||
    getAddressDecoder().decode(executable.data.slice(4, 36)) !== programData ||
    data.programAddress !== LOADER ||
    data.data.length < 45 ||
    new DataView(
      data.data.buffer,
      data.data.byteOffset,
      data.data.byteLength,
    ).getUint32(0, true) !== 3 ||
    data.data[12] !== 1 ||
    getAddressDecoder().decode(data.data.slice(13, 45)) !== signer.address
  ) {
    throw new Error(
      "Connect this deployed program's current upgrade-authority wallet to initialize its operational authority.",
    );
  }
  return programData;
}
export async function buildInitializePlatformInstruction(
  rpc: Rpc,
  input: Omit<
    Parameters<typeof getInitializePlatformInstructionAsync>[0],
    "programData" | "program"
  >,
) {
  const programData = await requireProgramUpgradeAuthority(
    rpc,
    ASSET_REGISTRY_PROGRAM_ADDRESS,
    input.upgradeAuthority,
  );
  return getInitializePlatformInstructionAsync({
    ...input,
    program: ASSET_REGISTRY_PROGRAM_ADDRESS,
    programData,
  });
}
export async function buildInitializeBlocklistAuthorityInstruction(
  rpc: Rpc,
  input: Omit<
    Parameters<typeof getInitializeBlocklistAuthorityInstructionAsync>[0],
    "programData" | "program"
  >,
) {
  const programData = await requireProgramUpgradeAuthority(
    rpc,
    TRANSFER_HOOK_PROGRAM_ADDRESS,
    input.upgradeAuthority,
  );
  return getInitializeBlocklistAuthorityInstructionAsync({
    ...input,
    program: TRANSFER_HOOK_PROGRAM_ADDRESS,
    programData,
  });
}

// ── Who the bootstrap appoints (Talas 3.1 K2 / K3) ──────────────────────────
//
// initialize_platform and initialize_blocklist_authority are one-time inits
// authorized by each program's upgrade authority. No path may silently use
// the connected wallet for a role, and no browser path may write an unproven
// third-party key into a slot that cannot be re-initialized:
//
// * browser (devnet / testnet / localnet only): "self, then rotate" — the
//   connected upgrade authority becomes the initial Super Admin (admin #1)
//   and blocklist authority, then proposes the permanent keys, which prove
//   control by accepting at /account/roles. The treasury is an explicit
//   input (fixable later with set_protocol_treasury).
// * mainnet: the 3.3 CLI only (an explicit blocklist authority there needs a
//   signed proof of control). The builders above stay network-agnostic so
//   the CLI reuses them; this validator is where the browser refuses.

export type BootstrapSurface = "browser" | "cli";

export type BootstrapRoleInput = {
  network: Network;
  surface: BootstrapSurface;
  /** The program upgrade authority that signs the init (the connected wallet in the browser). */
  upgradeAuthority: string | null;
  /** Platform init: the initial Super Admin. */
  superAdmin?: string | null;
  /** Platform init: the protocol treasury (required). */
  treasury?: string | null;
  /** Blocklist init: the initial blocklist authority. */
  blocklistAuthority?: string | null;
  /** Optional successor proposed right after the platform init. */
  permanentSuperAdmin?: string | null;
  /** Optional successor proposed right after the blocklist init. */
  permanentBlocklistAuthority?: string | null;
};

export type BootstrapRoleCheck = {
  /** Any error blocks the init. */
  errors: string[];
  /** Shown next to the inputs; they do not block. */
  warnings: string[];
};

export const MAINNET_BOOTSTRAP_REFUSAL = "Mainnet bootstrap runs only through the 3.3 CLI";

const K11_HINT = "use the Squads vault PDA (K11); set_protocol_treasury can change it later";

function keyError(value: string | null | undefined, label: string): string | null {
  const v = value?.trim() ?? "";
  if (!v) return `${label} is required.`;
  if (!isAddress(v)) return `${label} is not a valid Solana address.`;
  if (v === DEFAULT_ADDRESS) return `${label} cannot be the default 1111…1111 address.`;
  return null;
}

/**
 * Checks the keys a bootstrap would appoint. Platform fields are checked when
 * `superAdmin` or `treasury` is present, blocklist fields when
 * `blocklistAuthority` is. The browser is refused on mainnet outright.
 */
export function bootstrapRoleErrors(input: BootstrapRoleInput): BootstrapRoleCheck {
  if (input.surface === "browser" && input.network === "mainnet") {
    return { errors: [MAINNET_BOOTSTRAP_REFUSAL], warnings: [] };
  }
  const errors: string[] = [];
  const warnings: string[] = [];
  const push = (e: string | null) => {
    if (e) errors.push(e);
  };
  const ua = input.upgradeAuthority?.trim() || null;
  if (!ua) errors.push("Connect the program's upgrade-authority wallet.");
  const browser = input.surface === "browser";

  const platform = input.superAdmin !== undefined || input.treasury !== undefined;
  if (platform) {
    const sa = input.superAdmin?.trim() ?? "";
    push(keyError(sa, "The Super Admin"));
    if (browser && sa && ua && sa !== ua) {
      errors.push(
        "In the browser the initial Super Admin is the connected upgrade authority; propose the permanent Super Admin after the init.",
      );
    }
    const treasury = input.treasury?.trim() ?? "";
    if (!treasury) {
      errors.push("The protocol treasury is required.");
    } else {
      const invalid = protocolTreasuryError(treasury, null);
      if (invalid) errors.push(invalid);
      else if (ua && treasury === ua) warnings.push(`The treasury is the upgrade-authority wallet: ${K11_HINT}.`);
      else if (sa && treasury === sa) warnings.push(`The treasury is the Super Admin wallet: ${K11_HINT}.`);
    }
    const next = input.permanentSuperAdmin?.trim() ?? "";
    if (next) {
      push(keyError(next, "The permanent Super Admin"));
      if (next === sa) errors.push("The permanent Super Admin must differ from the initial one (leave it empty to keep it).");
    }
  }

  if (input.blocklistAuthority !== undefined) {
    const ba = input.blocklistAuthority?.trim() ?? "";
    push(keyError(ba, "The blocklist authority"));
    if (browser && ba && ua && ba !== ua) {
      errors.push(
        "No browser path writes another key into the one-time blocklist init: the connected upgrade authority becomes the blocklist authority and proposes the permanent one next.",
      );
    }
    const next = input.permanentBlocklistAuthority?.trim() ?? "";
    if (next) {
      push(keyError(next, "The permanent blocklist authority"));
      if (next === ba) {
        errors.push("The permanent blocklist authority must differ from the initial one (leave it empty to keep it).");
      }
    }
  }
  return { errors, warnings };
}
