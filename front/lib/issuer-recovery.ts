import {
  address,
  blockhash,
  compileTransaction,
  createNoopSigner,
  createTransactionMessage,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  appendTransactionMessageInstructions,
  getBase58Encoder,
  getBase58Decoder,
  getPublicKeyFromAddress,
  verifySignature,
  assertIsSignatureBytes,
  assertIsTransactionWithinSizeLimit,
  assertIsFullySignedTransaction,
  getBase64EncodedWireTransaction,
  isTransactionPartialSigner,
  type TransactionSigner,
  type Address,
} from "@solana/kit";
import {
  fetchMaybePlatform,
  fetchMaybeIssuer,
  findPlatformPda,
  getRecoverIssuerRegistrationInstructionAsync,
  ASSET_REGISTRY_PROGRAM_ADDRESS,
  KybStatus,
} from "@/lib/generated/asset_registry";
import {
  createNetworkVerifier,
  expectedGenesisHash,
} from "@/lib/network-identity";
import type { Network } from "@/lib/network";
import type { fetchMintTokenProgram } from "@/lib/transaction-builders";
type Rpc = Parameters<typeof fetchMintTokenProgram>[0];
/** Only typed recovery terms are imported. The transaction is rebuilt locally;
 * an imported document can never insert a transfer or arbitrary instruction. */
export type IssuerRecoveryEnvelope = {
  version: 1;
  network: Network;
  genesisHash: string;
  issuer: string;
  previousAuthority: string;
  superAdmin: string;
  newAuthority: string;
  jurisdiction: number;
  kybDocHash: string;
  blockhash: string;
  lastValidBlockHeight: string;
  signatures: Record<string, string>;
};
export function parseIssuerRecovery(
  raw: string,
  network: Network,
): IssuerRecoveryEnvelope {
  if (raw.length > 16_000) throw new Error("Recovery document is too large");
  const e = JSON.parse(raw) as IssuerRecoveryEnvelope;
  if (
    e.version !== 1 ||
    e.network !== network ||
    e.genesisHash !== expectedGenesisHash(network) ||
    !Number.isInteger(e.jurisdiction) ||
    e.jurisdiction < 1 ||
    e.jurisdiction > 999 ||
    !/^[0-9a-f]{64}$/.test(e.kybDocHash) ||
    !/^\d+$/.test(e.lastValidBlockHeight) ||
    !e.signatures ||
    typeof e.signatures !== "object" ||
    Array.isArray(e.signatures)
  )
    throw new Error("Invalid recovery terms or network");
  for (const value of [
    e.issuer,
    e.previousAuthority,
    e.superAdmin,
    e.newAuthority,
  ])
    address(value);
  blockhash(e.blockhash);
  if (e.newAuthority === e.previousAuthority)
    throw new Error("Recovery must name a new issuer authority");
  for (const [key, value] of Object.entries(e.signatures))
    if (
      (key !== e.superAdmin && key !== e.newAuthority) ||
      typeof value !== "string"
    )
      throw new Error("Unexpected recovery signer");
  return e;
}
async function assertRecoveryLive(rpc: Rpc, e: IssuerRecoveryEnvelope) {
  await createNetworkVerifier(rpc, e.network)();
  const [platformPda] = await findPlatformPda(),
    opts = {
      commitment: "finalized" as const,
      abortSignal: AbortSignal.timeout(10_000),
    };
  const [platform, issuer] = await Promise.all([
    fetchMaybePlatform(rpc, platformPda, opts),
    fetchMaybeIssuer(rpc, address(e.issuer), opts),
  ]);
  if (
    !platform.exists ||
    platform.programAddress !== ASSET_REGISTRY_PROGRAM_ADDRESS ||
    platform.data.admin !== e.superAdmin
  )
    throw new Error(
      "The current Super Admin does not match this recovery document",
    );
  if (
    !issuer.exists ||
    issuer.programAddress !== ASSET_REGISTRY_PROGRAM_ADDRESS ||
    issuer.data.authority !== e.previousAuthority ||
    issuer.data.assetsCount !== BigInt(0) ||
    ![KybStatus.Pending, KybStatus.Rejected].includes(issuer.data.kybStatus)
  )
    throw new Error(
      "This issuer registration is no longer recoverable with these terms",
    );
  const valid = await rpc
    .isBlockhashValid(blockhash(e.blockhash), { commitment: "confirmed" })
    .send({ abortSignal: AbortSignal.timeout(10_000) });
  if (!valid.value)
    throw new Error(
      "This recovery blockhash expired. Prepare a new document and obtain both signatures again.",
    );
  return platformPda;
}
export async function prepareIssuerRecovery(
  rpc: Rpc,
  network: Network,
  input: {
    issuer: Address;
    newAuthority: Address;
    jurisdiction: number;
    kybDocHash: string;
  },
) {
  await createNetworkVerifier(rpc, network)();
  const [platformPda] = await findPlatformPda(),
    opts = { commitment: "finalized" as const };
  const [platform, issuer, lifetime] = await Promise.all([
    fetchMaybePlatform(rpc, platformPda, opts),
    fetchMaybeIssuer(rpc, input.issuer, opts),
    rpc.getLatestBlockhash({ commitment: "confirmed" }).send(),
  ]);
  if (!platform.exists || !issuer.exists)
    throw new Error("Issuer or platform account is unavailable");
  const e = parseIssuerRecovery(
    JSON.stringify({
      version: 1,
      network,
      genesisHash: expectedGenesisHash(network),
      ...input,
      previousAuthority: issuer.data.authority,
      superAdmin: platform.data.admin,
      kybDocHash: input.kybDocHash.toLowerCase(),
      blockhash: lifetime.value.blockhash,
      lastValidBlockHeight: String(lifetime.value.lastValidBlockHeight),
      signatures: {},
    }),
    network,
  );
  await assertRecoveryLive(rpc, e);
  return e;
}
export async function compileIssuerRecovery(e: IssuerRecoveryEnvelope) {
  e = parseIssuerRecovery(JSON.stringify(e), e.network);
  const [platform] = await findPlatformPda(),
    admin = createNoopSigner(address(e.superAdmin)),
    newAuthority =
      e.superAdmin === e.newAuthority
        ? admin
        : createNoopSigner(address(e.newAuthority));
  const ix = await getRecoverIssuerRegistrationInstructionAsync({
    superAdmin: admin,
    platform,
    issuer: address(e.issuer),
    newAuthority,
    jurisdiction: e.jurisdiction,
    kybDocHash: Uint8Array.from(e.kybDocHash.match(/../g)!, (value) =>
      parseInt(value, 16),
    ),
  });
  const message = appendTransactionMessageInstructions(
    [ix],
    setTransactionMessageLifetimeUsingBlockhash(
      {
        blockhash: blockhash(e.blockhash),
        lastValidBlockHeight: BigInt(e.lastValidBlockHeight),
      },
      setTransactionMessageFeePayer(
        admin.address,
        createTransactionMessage({ version: 0 }),
      ),
    ),
  );
  const unsigned = compileTransaction(message),
    signatures = { ...unsigned.signatures };
  for (const [key, value] of Object.entries(e.signatures)) {
    const bytes = Uint8Array.from(getBase58Encoder().encode(value));
    assertIsSignatureBytes(bytes);
    if (
      !(await verifySignature(
        await getPublicKeyFromAddress(address(key)),
        bytes,
        unsigned.messageBytes,
      ))
    )
      throw new Error("A recovery signature does not match the reviewed terms");
    signatures[address(key)] = bytes;
  }
  const transaction = { ...unsigned, signatures };
  assertIsTransactionWithinSizeLimit(transaction);
  return transaction;
}
export async function signIssuerRecovery(
  rpc: Rpc,
  e: IssuerRecoveryEnvelope,
  signer: TransactionSigner,
) {
  if (signer.address !== e.superAdmin && signer.address !== e.newAuthority)
    throw new Error(
      "Connect the current Super Admin or proposed issuer authority",
    );
  if (!isTransactionPartialSigner(signer))
    throw new Error(
      "This wallet must support signing without sending to collect both approvals",
    );
  await assertRecoveryLive(rpc, e);
  const transaction = await compileIssuerRecovery(e);
  const signed = await signer.signTransactions([transaction]),
    sig = signed[0]?.[signer.address];
  if (!sig) throw new Error("The wallet did not return its recovery signature");
  const next = {
    ...e,
    signatures: {
      ...e.signatures,
      [signer.address]: getBase58Decoder().decode(sig),
    },
  };
  await compileIssuerRecovery(next);
  return next;
}
export async function submitIssuerRecovery(
  rpc: Rpc,
  e: IssuerRecoveryEnvelope,
) {
  await assertRecoveryLive(rpc, e);
  const transaction = await compileIssuerRecovery(e);
  assertIsFullySignedTransaction(transaction);
  // This path imports no wire bytes and re-verifies cluster identity immediately
  // before the only send, after validating both signatures over the exact message.
  await createNetworkVerifier(rpc, e.network)();
  return rpc
    .sendTransaction(getBase64EncodedWireTransaction(transaction), {
      encoding: "base64",
      skipPreflight: false,
      preflightCommitment: "confirmed",
      maxRetries: BigInt(3),
    })
    .send({ abortSignal: AbortSignal.timeout(20_000) });
}
