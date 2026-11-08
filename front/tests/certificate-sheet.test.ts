// The printable certificate (app/admin/certificates/certificate-sheet.tsx),
// rendered to static markup: it states the number, the statement, the facts,
// the hash, the signer, the signature and the anchor from the stored row; it
// marks a draft and a revoked certificate as such on the sheet itself (a
// printout carries no page around it); it carries the verification URL and
// the signed bytes; and its print rules show the sheet alone.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CERTIFICATE_PRINT_CSS, CertificateSheet } from "@/app/admin/certificates/certificate-sheet";
import type { CertificateDetail } from "@/lib/certificates/payload";
import { EVIDENCE_TX, HOLDER, certificateSigner, fixturePayload } from "./helpers/certificate-fixtures";

async function detail(over: Partial<CertificateDetail> = {}, network: "devnet" | "mainnet" = "mainnet"): Promise<CertificateDetail> {
  const wallet = await certificateSigner();
  const { payload, canonical, sha256 } = await fixturePayload({
    network,
    signer: wallet.address,
    holder: { wallet: HOLDER, name: "Petar Petrović", idNumber: "ID-TEST-0001" },
  });
  return {
    id: "00000000-0000-4000-8000-000000000001",
    network,
    number: "MC-2026-0001",
    kind: "holding",
    status: "anchored",
    asset_pda: payload.asset.asset_pda,
    share_class_pda: payload.share_class.share_class_pda,
    holder_wallet: HOLDER,
    payload_canonical: canonical,
    payload_sha256: sha256,
    signer: wallet.address,
    signature: await wallet.sign("MC-2026-0001", sha256),
    signature_format: "raw",
    signed_at: "2026-11-08T10:16:00.000Z",
    anchor_tx: EVIDENCE_TX,
    anchor_slot: 380_124_000,
    anchor_block_time: "2026-11-08T10:17:00.000Z",
    anchored_at: "2026-11-08T10:17:30.000Z",
    revoked_at: null,
    revoked_by: null,
    revoke_reason: null,
    created_by: wallet.address,
    created_at: "2026-11-08T10:15:30.123Z",
    updated_at: "2026-11-08T10:17:30.000Z",
    payload,
    ...over,
  };
}

const VERIFY_URL = "https://www.manci.io/certificates/verify?number=MC-2026-0001";
const render = (d: CertificateDetail) => renderToStaticMarkup(createElement(CertificateSheet, { detail: d, verifyUrl: VERIFY_URL }));
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");

describe("the printable certificate", () => {
  it("states the number, the statement, the holder, the integrity facts and the verification URL", async () => {
    const d = await detail();
    const page = text(render(d));
    expect(page).toContain("Certificate of tokenized interest");
    expect(page).toContain("Holding certificate");
    expect(page).toContain("MC-2026-0001");
    expect(page).toContain("Signed and anchored on chain");
    expect(page).toContain(text(d.payload.statement));
    expect(page).toContain("Manci International Ltd.");
    expect(page).toContain("Petar Petrović");
    expect(page).toContain("ID-TEST-0001");
    expect(page).toContain("250 units");
    expect(page).toContain("2.5 %");
    expect(page).toContain(d.payload_sha256);
    expect(page).toContain(d.signature!);
    expect(page).toContain(EVIDENCE_TX);
    expect(page).toContain(`MC-2026-0001 sha256:${d.payload_sha256}`);
    expect(page).toContain(VERIFY_URL);
    // The signed bytes are printed as they were hashed.
    const escaped = d.payload_canonical.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;").replace(/</g, "&lt;");
    expect(render(d)).toContain(escaped);
    expect(page).not.toContain("TEST NETWORK");
    expect(page).not.toContain("Draft");
  });

  it("marks a draft, a revoked certificate and a test network on the sheet itself", async () => {
    const draft = text(render(await detail({ status: "draft", signature: null, signature_format: null, signed_at: null, anchor_tx: null, anchored_at: null })));
    expect(draft).toContain("Draft — not signed — no validity");
    expect(draft).toContain("Not signed");
    expect(draft).toContain("Not anchored yet");
    const revoked = text(render(await detail({ status: "revoked", revoked_at: "2026-11-09T08:00:00.000Z", revoked_by: HOLDER, revoke_reason: "Issued in error" })));
    expect(revoked).toContain("Revoked on 2026-11-09 08:00:00 UTC");
    expect(revoked).not.toContain("Issued in error");
    const devnet = text(render(await detail({}, "devnet")));
    expect(devnet).toContain("Devnet test network: this certificate has no legal effect");
  });

  it("prints the sheet alone, on A4", () => {
    expect(CERTIFICATE_PRINT_CSS).toContain("@page { size: A4;");
    expect(CERTIFICATE_PRINT_CSS).toMatch(/body \*:not\(:has\(\.certificate-sheet\)\):not\(\.certificate-sheet\):not\(\.certificate-sheet \*\) \{ display: none !important; \}/);
    expect(CERTIFICATE_PRINT_CSS).toContain(".certificate-no-print { display: none !important; }");
  });
});
