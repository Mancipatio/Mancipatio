import {
  getAddressEncoder,
  getProgramDerivedAddress,
  type Address,
  type TransactionSigner,
} from "@solana/kit";
import {
  ASSET_REGISTRY_PROGRAM_ADDRESS,
  fetchMaybeIssuer,
  fetchMaybeIssuerPermissions,
  fetchMaybeAdmin,
  fetchMaybePlatform,
  findAdminRecordPda,
  findPlatformPda,
  getSetIssuerPermissionsInstructionAsync,
} from "@/lib/generated/asset_registry";
import type { fetchMintTokenProgram } from "@/lib/transaction-builders";
export const ISSUER_CAPABILITIES = {
  Mint: 1,
  Metadata: 2,
  Conversion: 4,
} as const;
type Rpc = Parameters<typeof fetchMintTokenProgram>[0];
export async function findIssuerPermissionsAddress(
  issuer: Address,
  authority: Address,
) {
  return (
    await getProgramDerivedAddress({
      programAddress: ASSET_REGISTRY_PROGRAM_ADDRESS,
      seeds: [
        new TextEncoder().encode("issuer_permissions"),
        getAddressEncoder().encode(issuer),
        getAddressEncoder().encode(authority),
      ],
    })
  )[0];
}
export async function loadIssuerPermission(
  rpc: Rpc,
  issuerPda: Address,
  authority: Address,
) {
  const options = {
    commitment: "finalized" as const,
    abortSignal: AbortSignal.timeout(10_000),
  };
  const issuer = await fetchMaybeIssuer(rpc, issuerPda, options);
  if (
    !issuer.exists ||
    issuer.programAddress !== ASSET_REGISTRY_PROGRAM_ADDRESS ||
    issuer.data.authority !== authority
  )
    throw new Error(
      "Only this issuer's current authority can use its operational permissions",
    );
  const scoped = await findIssuerPermissionsAddress(issuerPda, authority),
    [adminPda] = await findAdminRecordPda({ authority });
  const [admin, permission] = await Promise.all([
    fetchMaybeAdmin(rpc, adminPda, options),
    fetchMaybeIssuerPermissions(rpc, scoped, options),
  ]);
  if (
    admin.exists &&
    admin.programAddress === ASSET_REGISTRY_PROGRAM_ADDRESS &&
    admin.data.admin === authority
  )
    return { proof: adminPda, capabilities: 7, globalAdmin: true };
  if (
    permission.exists &&
    (permission.programAddress !== ASSET_REGISTRY_PROGRAM_ADDRESS ||
      permission.data.issuer !== issuerPda ||
      permission.data.authority !== authority)
  )
    throw new Error("Invalid issuer permission account");
  return {
    proof: scoped,
    capabilities: permission.exists ? permission.data.capabilities : 0,
    globalAdmin: false,
  };
}
export async function resolveIssuerPermission(
  rpc: Rpc,
  issuer: Address,
  authority: Address,
  capability: number,
) {
  const permission = await loadIssuerPermission(rpc, issuer, authority);
  if ((permission.capabilities & capability) !== capability)
    throw new Error(
      "This issuer wallet does not have the required scoped permission. The Super Admin can grant it in the issuer review panel.",
    );
  return permission.proof;
}
export async function buildSetIssuerPermissions(
  rpc: Rpc,
  issuerPda: Address,
  signer: TransactionSigner,
  capabilities: number,
) {
  if (!Number.isInteger(capabilities) || capabilities < 0 || capabilities > 7)
    throw new Error("Invalid issuer capability set");
  const options = {
      commitment: "finalized" as const,
      abortSignal: AbortSignal.timeout(10_000),
    },
    [platformPda] = await findPlatformPda();
  const [platform, issuer] = await Promise.all([
    fetchMaybePlatform(rpc, platformPda, options),
    fetchMaybeIssuer(rpc, issuerPda, options),
  ]);
  if (
    !platform.exists ||
    platform.programAddress !== ASSET_REGISTRY_PROGRAM_ADDRESS ||
    platform.data.admin !== signer.address
  )
    throw new Error(
      "Only the current Super Admin can grant or revoke issuer permissions",
    );
  if (
    !issuer.exists ||
    issuer.programAddress !== ASSET_REGISTRY_PROGRAM_ADDRESS
  )
    throw new Error("Issuer could not be verified");
  const permissions = await findIssuerPermissionsAddress(
    issuerPda,
    issuer.data.authority,
  );
  return getSetIssuerPermissionsInstructionAsync({
    superAdmin: signer,
    platform: platformPda,
    issuer: issuerPda,
    permissions,
    capabilities,
  });
}
