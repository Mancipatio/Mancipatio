import {
  address,
  assertAccountExists,
  fetchEncodedAccount,
  getAddressDecoder,
  getAddressEncoder,
  getProgramDerivedAddress,
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
