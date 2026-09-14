"use client";

import type { WalletSession } from "@solana/client";
import { signedFetch } from "@/lib/siws-client";

/** Off-chain onboarding profile for an on-chain Issuer.
 *  The on-chain Issuer account only carries legal_entity_id / jurisdiction /
 *  KYB status, so the company name, contact email and website collected during
 *  the onboarding wizard live here, keyed by the Issuer PDA. See migration 0015. */
export type IssuerProfile = {
  issuer_pda: string;
  legal_entity_id: string | null;
  network: string;
  company_name: string | null;
  contact_email: string | null;
  website: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export type NewIssuerProfile = Partial<IssuerProfile> & {
  issuer_pda: string;
};

/** Private onboarding/contact data is available only to the issuer or admin. */
export async function getIssuerProfile(
  session: WalletSession | null | undefined, issuerPda: string,
): Promise<IssuerProfile | null> {
  return (await getIssuerProfiles(session, [issuerPda])).get(issuerPda) ?? null;
}

export async function getIssuerProfiles(
  session: WalletSession | null | undefined, issuerPdas: string[],
): Promise<Map<string, IssuerProfile>> {
  const rows: IssuerProfile[] = [];
  for (let offset = 0; offset < issuerPdas.length; offset += 100) {
    rows.push(...await signedFetch<IssuerProfile[]>(session, "/api/issuer-profiles/read", "issuer-profiles.read", {
      pdas: issuerPdas.slice(offset, offset + 100),
    }));
  }
  return new Map(rows.map((row) => [row.issuer_pda, row]));
}

/**
 * Create/update the issuer onboarding profile via the signed route.
 * Authorization is server-enforced (SD4): platform admin OR wallet ==
 * Issuer.authority of the on-chain account at `issuer_pda`. `network` and
 * `created_by` are stamped server-side. Best-effort boolean, matching the
 * old contract.
 */
export async function upsertIssuerProfile(
  session: WalletSession | null | undefined,
  profile: NewIssuerProfile,
): Promise<boolean> {
  try {
    await signedFetch(
      session,
      "/api/issuer-profiles/upsert",
      "issuer-profiles.upsert",
      { profile },
    );
    return true;
  } catch (e) {
    console.warn("[issuer-profiles] upsertIssuerProfile:", e);
    return false;
  }
}
