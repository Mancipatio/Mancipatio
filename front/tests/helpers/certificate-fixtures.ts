// Shared fixtures of the certificate suites (tests/certificate-*.test.ts,
// tests/certificates.postgres.test.ts): chain facts shaped after the first
// mainnet asset (MANCI-2026: 10,000 units = 100 % of the company, class 0
// capped at 1,750 = 17.5 %, a holder with 250 units = 2.5 %), payloads built
// with the real builder, and a fresh Ed25519 wallet that signs certificate
// messages. Addresses that are not public facts are derived from fixed
// bytes; no real key is used.
import { generateKeyPair, getAddressDecoder, getAddressFromPublicKey, signBytes, type Address } from "@solana/kit";
import { canonicalDigest } from "@/lib/certificates/canonical";
import {
  buildCertificatePayload,
  certificateMessage,
  type BuildCertificateInput,
  type CertificateChainFacts,
  type CertificateKind,
  type CertificatePayload,
} from "@/lib/certificates/payload";
import { signatureToBase58 } from "@/lib/certificates/signature";
import { siwsSignedBytes, type SiwsSignatureFormat } from "@/lib/siws-offchain";
import type { Network } from "@/lib/network";

export const fixedAddress = (seed: number) => getAddressDecoder().decode(new Uint8Array(32).fill(seed)).toString();

export const ASSET = "HzjgBogwPPMzj5m2CgGLyPUv5Qz27TmvbFy9MWbevuv6";
export const MINT = "7qpdkysejAWvSMaYp4qF2CYSkfLR39CcJoiMeDmwttWi";
export const HOLDER = fixedAddress(25);
export const SHARE_CLASS = fixedAddress(21);
export const ISSUER = fixedAddress(22);
export const LEGAL_DOC_HASH = "9a82646e".padEnd(64, "0");
export const EVIDENCE_TX = "5RBDZNDobPiJGpQsfcvPLuSdzyUXRxBnpXNU4sFQg2ud3sTiSPyWnPrfvyN4myMYTvEUWjtYnGijuryNNrXqeDqm";
export const COMPANY = {
  legal_name: "Primer d.o.o. Beograd",
  registration_number: "12345678",
  address: "Ulica Đure Đakovića 1, Beograd, Serbia",
};

export function chainFacts(kind: CertificateKind, over: Partial<{ units: bigint; circulating: bigint; maxSupply: bigint | null }> = {}): CertificateChainFacts {
  return {
    asset: { address: ASSET, assetId: "MANCI-2026", name: "MANCI 17.5%", symbolPrefix: "MANCI", legalDocHash: LEGAL_DOC_HASH, issuer: ISSUER },
    shareClass: {
      address: SHARE_CLASS,
      classIndex: 0,
      mint: MINT,
      maxSupply: over.maxSupply === undefined ? BigInt(1750) : over.maxSupply,
      lifetimeMinted: BigInt(500),
    },
    holding: kind === "holding" ? { units: over.units ?? BigInt(250), slot: BigInt(380_123_456) } : null,
    supply: kind === "issuance" ? { circulating: over.circulating ?? BigInt(250), slot: BigInt(380_123_457) } : null,
  };
}

export function buildInput(over: Partial<BuildCertificateInput> & { kind?: CertificateKind } = {}): BuildCertificateInput {
  const kind = over.kind ?? "holding";
  return {
    network: "devnet" as Network,
    number: "MC-2026-0001",
    kind,
    issuedAt: new Date("2026-11-08T10:15:30.123Z"),
    salt: "0123456789abcdef0123456789abcdef",
    company: COMPANY,
    unitsFor100Percent: BigInt(10_000),
    holder: kind === "holding" ? { wallet: HOLDER, name: null, idNumber: null } : null,
    evidence: [],
    chain: chainFacts(kind),
    signer: fixedAddress(23),
    ...over,
  };
}

export async function fixturePayload(over: Partial<BuildCertificateInput> & { kind?: CertificateKind } = {}) {
  const payload: CertificatePayload = buildCertificatePayload(buildInput(over));
  const { canonical, sha256 } = await canonicalDigest(payload);
  return { payload, canonical, sha256 };
}

/** A fresh wallet that signs certificate messages, as a wallet's signMessage would (raw text or an off-chain envelope). */
export async function certificateSigner() {
  const keys = await generateKeyPair();
  const address: Address = await getAddressFromPublicKey(keys.publicKey);
  return {
    address: address.toString(),
    async sign(number: string, sha256: string, format: SiwsSignatureFormat = "raw"): Promise<string> {
      const bytes = siwsSignedBytes(certificateMessage(number, sha256), address.toString(), format);
      return signatureToBase58(new Uint8Array(await signBytes(keys.privateKey, bytes)));
    },
  };
}
