"use client";

// Browser side of the admin's certificates (lib/certificates/payload.ts): the
// signed calls of /admin/certificates, the wallet signature of a draft and the
// JSON download. The public check of /certificates/verify is
// lib/certificates/public-check.ts (no wallet code there).
//
// Signing a draft is two steps with one wallet prompt each at most: the
// wallet signs the certificate's message (certificateMessage: number and
// SHA-256, built from what the server stored, never edited here) through the
// same helper as a SIWS request, so a Ledger behind Phantom or Solflare gets
// its off-chain envelope; then the signature is posted as a session action
// (no second prompt while the wallet session lasts). The server verifies it
// against the stored row before it records anything.

import type { WalletSession } from "@solana/client";
import { signedFetch, type SignedFetchInteractive } from "@/lib/siws-client";
import { signSiwsMessage } from "@/lib/siws-signing";
import {
  certificateMessage,
  type CertificateDetail,
  type CertificateListItem,
  type CertificatePreview,
} from "@/lib/certificates/payload";
import { signatureToBase58 } from "@/lib/certificates/signature";
import { CERTIFICATE_ACTIONS, CERTIFICATE_PATHS } from "@/lib/certificates/routes";

/** The form's request (/preview and /create), as the routes read it. */
export type CertificateFormParams = {
  kind: "holding" | "issuance";
  share_class: string;
  wallet?: string;
  company?: { legal_name: string; registration_number: string; address: string };
  units_for_100_percent?: string;
  holder_name?: string;
  holder_id_number?: string;
  evidence?: Array<{ signature: string; note?: string }>;
};

export function listCertificates(
  session: WalletSession | null | undefined,
  interactive: SignedFetchInteractive = true,
): Promise<CertificateListItem[]> {
  return signedFetch<CertificateListItem[]>(session, CERTIFICATE_PATHS.list, CERTIFICATE_ACTIONS.list, {}, { interactive });
}

export function readCertificate(
  session: WalletSession | null | undefined,
  id: string,
  interactive: SignedFetchInteractive = true,
): Promise<CertificateDetail> {
  return signedFetch<CertificateDetail>(session, CERTIFICATE_PATHS.read, CERTIFICATE_ACTIONS.read, { id }, { interactive });
}

export function previewCertificate(session: WalletSession | null | undefined, params: CertificateFormParams): Promise<CertificatePreview> {
  return signedFetch<CertificatePreview>(session, CERTIFICATE_PATHS.preview, CERTIFICATE_ACTIONS.preview, params);
}

/** Creates a draft: a fresh wallet signature (it allocates the next number). */
export function createCertificate(session: WalletSession | null | undefined, params: CertificateFormParams): Promise<CertificateDetail> {
  return signedFetch<CertificateDetail>(session, CERTIFICATE_PATHS.create, CERTIFICATE_ACTIONS.create, params);
}

/** Thrown before any prompt when the connected wallet is not the draft's signer. */
export class CertificateSignerMismatchError extends Error {
  constructor(readonly signer: string) {
    super(`This draft names ${signer} as its signer. Connect that wallet to sign it.`);
    this.name = "CertificateSignerMismatchError";
  }
}

/**
 * The connected wallet signs the draft's message, and the signature is
 * recorded. Throws CertificateSignerMismatchError (nothing prompted) when the
 * wallet is not the draft's signer, the wallet's rejection (code 4001) or
 * error, or the server's refusal.
 */
export async function signCertificate(session: WalletSession, detail: CertificateDetail): Promise<CertificateDetail> {
  const wallet = session.account.address.toString();
  if (wallet !== detail.signer) throw new CertificateSignerMismatchError(detail.signer);
  const signMessage = session.signMessage;
  if (!signMessage) throw new Error("This wallet cannot sign messages.");
  const message = certificateMessage(detail.number, detail.payload_sha256);
  const { signature, sigFormat } = await signSiwsMessage(session, signMessage, message, wallet);
  return signedFetch<CertificateDetail>(session, CERTIFICATE_PATHS.sign, CERTIFICATE_ACTIONS.sign, {
    id: detail.id,
    signature: signatureToBase58(signature),
    signature_format: sigFormat,
  });
}

/** Attaches the recorded anchor: the given transaction, or (without one) the first recorded anchor of the number and hash. */
export function linkCertificateAnchor(
  session: WalletSession | null | undefined,
  id: string,
  signature?: string,
): Promise<CertificateDetail> {
  return signedFetch<CertificateDetail>(session, CERTIFICATE_PATHS.anchor, CERTIFICATE_ACTIONS.anchor, {
    id,
    ...(signature ? { signature } : {}),
  });
}

/** Revokes (a draft: discards) with a reason: a fresh wallet signature. */
export function revokeCertificate(session: WalletSession | null | undefined, id: string, reason: string): Promise<CertificateDetail> {
  return signedFetch<CertificateDetail>(session, CERTIFICATE_PATHS.revoke, CERTIFICATE_ACTIONS.revoke, { id, reason });
}

/** Saves the exact signed bytes as "<number>.json" (their SHA-256 is the certificate's). */
export function downloadCertificateJson(detail: Pick<CertificateDetail, "number" | "payload_canonical">): void {
  const blob = new Blob([detail.payload_canonical], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${detail.number}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}
