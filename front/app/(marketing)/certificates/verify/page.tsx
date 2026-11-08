import type { Metadata } from "next";
import { Suspense } from "react";
import { Bullets, H2, PageHeader, Section } from "@/components/mx";
import { CertificateVerifier } from "./certificate-verifier";

// The public check of a certificate of tokenized interest (POST
// /api/certificates/verify). Open in KYC-only mode: it offers nothing and
// records nothing; it answers what the operator issued. The certificate
// carries this page's URL with its number and SHA-256: the number alone
// gets only the status, the hash opens what the certificate states.
export const metadata: Metadata = {
  title: "Verify a certificate · Manci",
  description:
    "Check a Manci certificate of tokenized interest by its number and SHA-256: whether it is valid or revoked, what it states, who signed it and its anchor on Solana.",
};

const COVERS = [
  "A number alone shows only whether the certificate exists and whether it is valid or revoked. What it states opens with the SHA-256 printed on the certificate, or its JSON file: whoever checks a certificate holds it.",
  "Valid means: the operator issued the certificate, its signature by the key shown verifies, and it has not been revoked. A certificate states facts at the slot it names; a holding may have changed since.",
  "This page never shows a holder's name or identification number. They are part of the signed content: if your copy of the certificate's JSON file matches the SHA-256 here, its holder details are the ones that were signed.",
  "You can check everything without this site: the SHA-256 of the certificate's JSON (canonical, UTF-8), the Ed25519 signature of the signed message by the signer's key, and the memo of the anchor transaction on a Solana explorer.",
];

export default function VerifyCertificatePage() {
  return (
    <>
      <PageHeader
        eyebrow="Certificates"
        title="Verify a certificate"
        lede="Enter the number and the SHA-256 printed on a Manci certificate of tokenized interest to see whether it is valid, what it states, who signed it and where it is anchored on chain."
      />
      <Section>
        <Suspense fallback={<p className="panel panel-pad text-sm text-slate-500">Loading…</p>}>
          <CertificateVerifier />
        </Suspense>
      </Section>
      <Section>
        <H2>What the check covers</H2>
        <div className="mt-6">
          <Bullets items={COVERS} />
        </div>
      </Section>
    </>
  );
}
