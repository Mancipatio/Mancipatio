import type { Network } from "@/lib/network";

/** Private, self-service contact profile. Separate from the KYC dossier. */
export type AccountProfile = {
  wallet: string;
  network: Network;
  display_name: string;
  email: string | null;
  email_verified_at: string | null;
  pending_email: string | null;
  pending_email_expires_at: string | null;
  google_email: string | null;
  google_linked_at: string | null;
  created_at: string;
  updated_at: string;
};

export type AccountFeatures = { google: boolean; email: boolean };
export type AccountResponse = { profile: AccountProfile; features: AccountFeatures };
