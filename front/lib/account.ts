import type { Network } from "@/lib/network";

/** Private, self-service contact profile. Separate from the KYC dossier. */
export type AccountProfile = {
  /** Stable shared account identity. A wallet address is never an account ID. */
  id: string;
  /** The wallet that authorized this response. */
  wallet: string;
  network: Network;
  primary_wallet: string;
  wallets: AccountWallet[];
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

export type AccountWallet = { wallet: string; linked_at: string };

/** Short-lived, target-bound attempt. Both wallets must approve linking. */
export type AccountWalletLinkAttempt = {
  token: string;
  account_id: string;
  requested_by: string;
  target_wallet: string;
  expires_at: string;
};

export type AccountTransactionWallet = {
  wallet: string;
  network: Network;
  account_id: string;
  primary_wallet: string;
};

export type AccountFeatures = { google: boolean; email: boolean };

/** Off-chain KYC dossier status of one linked wallet. KYC stays per wallet:
 * linking a wallet never shares or transfers a passport. */
export type AccountWalletKycStatus =
  | "none" | "pending" | "more_info" | "verified" | "expired" | "suspended" | "rejected";
export type AccountWalletKyc = { wallet: string; status: AccountWalletKycStatus; expires_at: string | null };

export type AccountResponse = {
  profile: AccountProfile;
  features: AccountFeatures;
  /** Null when the dossier directory could not be read; the profile still loads. */
  kyc?: AccountWalletKyc[] | null;
};
