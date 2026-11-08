// The new-certificate form of /admin/certificates as plain data: what the
// admin typed, the request /preview and /create read, and the prefill the
// preview answers with. Pure (tests/certificate-form.test.ts); the server
// re-validates every field (lib/certificates/payload.ts parseCertificateRequest).

import type { CertificateFormParams } from "@/lib/certificates-client";
import type { CertificatePrefill } from "@/lib/certificates/payload";

export type CertificateForm = {
  kind: "holding" | "issuance";
  shareClass: string;
  wallet: string;
  legalName: string;
  registrationNumber: string;
  address: string;
  unitsFor100Percent: string;
  holderName: string;
  holderIdNumber: string;
  /** One transaction per line: its signature, then an optional note after a space. */
  evidence: string;
};

export const EMPTY_CERTIFICATE_FORM: CertificateForm = {
  kind: "holding",
  shareClass: "",
  wallet: "",
  legalName: "",
  registrationNumber: "",
  address: "",
  unitsFor100Percent: "",
  holderName: "",
  holderIdNumber: "",
  evidence: "",
};

/** The evidence box as a list: "<signature> <note>" per line, blank lines skipped. */
export function evidenceFromText(text: string): Array<{ signature: string; note?: string }> {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const [signature, ...rest] = line.split(/\s+/);
      const note = rest.join(" ").trim();
      return note ? { signature, note } : { signature };
    });
}

/**
 * The request of the form, the same for the preview and for create. The
 * preview fills each company field and the scale left empty from its
 * prefill; create refuses them empty.
 */
export function certificateFormParams(form: CertificateForm): CertificateFormParams {
  const holding = form.kind === "holding";
  const params: CertificateFormParams = {
    kind: form.kind,
    share_class: form.shareClass.trim(),
    ...(holding ? { wallet: form.wallet.trim() } : {}),
    company: { legal_name: form.legalName, registration_number: form.registrationNumber, address: form.address },
    units_for_100_percent: form.unitsFor100Percent.trim(),
    ...(holding && form.holderName.trim() ? { holder_name: form.holderName } : {}),
    ...(holding && form.holderIdNumber.trim() ? { holder_id_number: form.holderIdNumber } : {}),
  };
  const evidence = evidenceFromText(form.evidence);
  return evidence.length > 0 ? { ...params, evidence } : params;
}

/**
 * The form with another share class. The company's details and the scale
 * belong to the asset: a class of another asset clears them, so the next
 * preview fills them in for that asset instead of carrying the previous
 * one's onto a certificate it does not concern.
 */
export function withShareClass(form: CertificateForm, shareClass: string, sameAsset: boolean): CertificateForm {
  if (sameAsset) return { ...form, shareClass };
  return { ...form, shareClass, legalName: "", registrationNumber: "", address: "", unitsFor100Percent: "" };
}

/** The form with the preview's prefill in every field the admin has not typed yet. */
export function withPrefill(form: CertificateForm, prefill: CertificatePrefill): CertificateForm {
  const fill = (typed: string, value: string) => (typed.trim() ? typed : value);
  return {
    ...form,
    legalName: fill(form.legalName, prefill.company.legal_name),
    registrationNumber: fill(form.registrationNumber, prefill.company.registration_number),
    address: fill(form.address, prefill.company.address),
    unitsFor100Percent: fill(form.unitsFor100Percent, prefill.units_for_100_percent ?? ""),
  };
}

/** Where the prefilled company details came from, as the form's hint says it. */
export function prefillSourceLabel(source: CertificatePrefill["company_source"]): string | null {
  switch (source) {
    case "certificate":
      return "from the last certificate of this asset";
    case "tokenization":
      return "from the tokenization record of this asset";
    case "issuer_profile":
      return "from the issuer's profile";
    case "spv":
      return "from the asset's SPV";
    default:
      return null;
  }
}
