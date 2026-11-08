// The new-certificate form of /admin/certificates as plain data
// (app/admin/certificates/certificate-form.ts): the evidence box, the request
// the preview and create read (an issuance never sends a holder), and the
// preview's prefill filling only what the admin has not typed.
import { describe, expect, it } from "vitest";
import {
  EMPTY_CERTIFICATE_FORM,
  certificateFormParams,
  evidenceFromText,
  prefillSourceLabel,
  withPrefill,
} from "@/app/admin/certificates/certificate-form";
import { parseCertificateRequest } from "@/lib/certificates/payload";
import { COMPANY, EVIDENCE_TX, HOLDER, SHARE_CLASS } from "./helpers/certificate-fixtures";

describe("certificate form", () => {
  it("reads one evidence transaction per line, with an optional note after it", () => {
    expect(evidenceFromText(`  ${EVIDENCE_TX}   Transfer of 500 units \n\n${EVIDENCE_TX.slice(0, 20)}\n`)).toEqual([
      { signature: EVIDENCE_TX, note: "Transfer of 500 units" },
      { signature: EVIDENCE_TX.slice(0, 20) },
    ]);
    expect(evidenceFromText(" \n ")).toEqual([]);
  });

  it("builds the request the routes read, without holder fields for an issuance", () => {
    const form = {
      ...EMPTY_CERTIFICATE_FORM,
      shareClass: SHARE_CLASS,
      wallet: ` ${HOLDER} `,
      legalName: COMPANY.legal_name,
      registrationNumber: COMPANY.registration_number,
      address: COMPANY.address,
      unitsFor100Percent: " 10000 ",
      holderName: "Petar Petrović",
      evidence: `${EVIDENCE_TX} Transfer`,
    };
    const holding = certificateFormParams(form);
    expect(holding).toEqual({
      kind: "holding",
      share_class: SHARE_CLASS,
      wallet: HOLDER,
      company: COMPANY,
      units_for_100_percent: "10000",
      holder_name: "Petar Petrović",
      evidence: [{ signature: EVIDENCE_TX, note: "Transfer" }],
    });
    expect(parseCertificateRequest(holding as unknown as Record<string, unknown>, true)).toMatchObject({ wallet: HOLDER, holderName: "Petar Petrović" });
    const issuance = certificateFormParams({ ...form, kind: "issuance" });
    expect(issuance).not.toHaveProperty("wallet");
    expect(issuance).not.toHaveProperty("holder_name");
    expect(parseCertificateRequest(issuance as unknown as Record<string, unknown>, true)).toMatchObject({ kind: "issuance", wallet: null });
  });

  it("fills only the fields the admin left empty from the preview's prefill", () => {
    const prefill = {
      company: { legal_name: "Prefilled d.o.o.", registration_number: "123", address: "Prefilled street 1" },
      company_source: "tokenization" as const,
      units_for_100_percent: "10000",
      scale_source: "tokenization" as const,
    };
    expect(withPrefill({ ...EMPTY_CERTIFICATE_FORM, legalName: "Typed d.o.o." }, prefill)).toMatchObject({
      legalName: "Typed d.o.o.",
      registrationNumber: "123",
      address: "Prefilled street 1",
      unitsFor100Percent: "10000",
    });
    expect(prefillSourceLabel("certificate")).toBe("from the last certificate of this asset");
    expect(prefillSourceLabel(null)).toBeNull();
  });
});
